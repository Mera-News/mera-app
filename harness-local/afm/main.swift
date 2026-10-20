// harness-local AFM bridge: Apple's on-device Foundation Model for the Mac
// harness, the same calls modules/mera-on-device-llm/ios/MeraOnDeviceLlmModule.swift
// makes on the phone.
//
// One JSON request per stdin line, one JSON response per stdout line, handled
// one at a time (the app holds a lock around the model too):
//   {"id":"1","cmd":"availability"}  -> {"id":"1","available":true,"reason":null,"contextSize":4096}
//   {"id":"2","instructions":"...","prompt":"...","schema":"<json schema text>"?,
//    "temperature":0.3?,"maxTokens":512?}  -> {"id":"2","text":"..."} | {"id":"2","error":"ERR_AFM_*"}
// A fresh LanguageModelSession per request, SystemLanguageModel.default only:
// never Private Cloud Compute.
//
// Build: swiftc -O harness-local/afm/main.swift -o ~/.cache/mera-harness/afm-bridge
// (adapters/afm-llm.ts builds it on first use).

import Foundation
import FoundationModels

struct BridgeError: Error {
  let code: String
}

private func schemaError() -> BridgeError { BridgeError(code: "ERR_AFM_UNKNOWN") }

// ---- copied from MeraOnDeviceLlmModule.swift (JsonReader + Afm.node), Expo types removed ----

// A JSON value that keeps object keys in source order (see schema()).
private indirect enum Json {
  case object([(String, Json)])
  case array([Json])
  case string(String)
  case number(Double)
  case literal

  subscript(key: String) -> Json? {
    if case .object(let fields) = self { return fields.first { $0.0 == key }?.1 }
    return nil
  }

  var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  var int: Int? {
    if case .number(let value) = self { return Int(exactly: value) }
    return nil
  }
}

private struct JsonReader {
  private let bytes: [UInt8]
  private var i = 0

  init(_ text: String) { bytes = Array(text.utf8) }

  private mutating func skipSpace() {
    while i < bytes.count, bytes[i] == 0x20 || bytes[i] == 0x0A || bytes[i] == 0x0D || bytes[i] == 0x09 { i += 1 }
  }

  private mutating func more(_ close: UInt8) throws -> Bool {
    skipSpace()
    guard i < bytes.count else { throw schemaError() }
    i += 1
    if bytes[i - 1] == UInt8(ascii: ",") { return true }
    if bytes[i - 1] == close { return false }
    throw schemaError()
  }

  private mutating func isEmpty(_ close: UInt8) -> Bool {
    skipSpace()
    guard i < bytes.count, bytes[i] == close else { return false }
    i += 1
    return true
  }

  mutating func document() throws -> Json {
    let root = try value()
    skipSpace()
    guard i == bytes.count else { throw schemaError() }
    return root
  }

  mutating func value() throws -> Json {
    skipSpace()
    guard i < bytes.count else { throw schemaError() }
    switch bytes[i] {
    case UInt8(ascii: "{"):
      i += 1
      var fields: [(String, Json)] = []
      if isEmpty(UInt8(ascii: "}")) { return .object(fields) }
      repeat {
        guard case .string(let key) = try value() else { throw schemaError() }
        skipSpace()
        guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { throw schemaError() }
        i += 1
        fields.append((key, try value()))
      } while try more(UInt8(ascii: "}"))
      return .object(fields)
    case UInt8(ascii: "["):
      i += 1
      var items: [Json] = []
      if isEmpty(UInt8(ascii: "]")) { return .array(items) }
      repeat { items.append(try value()) } while try more(UInt8(ascii: "]"))
      return .array(items)
    case UInt8(ascii: "\""):
      let start = i
      i += 1
      while i < bytes.count, bytes[i] != UInt8(ascii: "\"") { i += bytes[i] == UInt8(ascii: "\\") ? 2 : 1 }
      guard i < bytes.count else { throw schemaError() }
      i += 1
      let decoded = try? JSONSerialization.jsonObject(with: Data(bytes[start..<i]), options: .fragmentsAllowed)
      guard let text = decoded as? String else { throw schemaError() }
      return .string(text)
    default:
      let start = i
      while i < bytes.count, !",]} \n\r\t".utf8.contains(bytes[i]) { i += 1 }
      let token = String(decoding: bytes[start..<i], as: UTF8.self)
      if token == "true" || token == "false" || token == "null" { return .literal }
      guard let number = Double(token) else { throw schemaError() }
      return .number(number)
    }
  }
}

private func schema(_ json: String) throws -> GenerationSchema {
  var reader = JsonReader(json)
  let root = try reader.document()
  return try GenerationSchema(root: node(root, path: "root"), dependencies: [])
}

private func node(_ json: Json, path: String) throws -> DynamicGenerationSchema {
  let description = json["description"]?.string
  switch json["type"]?.string {
  case "object":
    guard case .object(let properties)? = json["properties"] else { throw schemaError() }
    var required: Set<String> = []
    if case .array(let names)? = json["required"] {
      required = Set(names.compactMap { $0.string })
    }
    return DynamicGenerationSchema(
      name: path,
      description: description,
      properties: try properties.map { key, child in
        DynamicGenerationSchema.Property(
          name: key,
          description: child["description"]?.string,
          schema: try node(child, path: "\(path).\(key)"),
          isOptional: !required.contains(key)
        )
      }
    )
  case "string":
    if case .array(let choices)? = json["enum"] {
      return DynamicGenerationSchema(name: path, description: description, anyOf: choices.compactMap { $0.string })
    }
    return DynamicGenerationSchema(type: String.self)
  case "integer":
    return DynamicGenerationSchema(type: Int.self)
  case "number":
    return DynamicGenerationSchema(type: Double.self)
  case "boolean":
    return DynamicGenerationSchema(type: Bool.self)
  case "array":
    guard let items = json["items"] else { throw schemaError() }
    return DynamicGenerationSchema(
      arrayOf: try node(items, path: "\(path)[]"),
      minimumElements: json["minItems"]?.int,
      maximumElements: json["maxItems"]?.int
    )
  default:
    throw schemaError()
  }
}

// The module's Afm.map, macOS 27 SDK branch first, then the deprecated GenerationError.
private func code(_ error: Error) -> String {
  if let bridge = error as? BridgeError { return bridge.code }
  if error is CancellationError { return "ERR_AFM_CANCELLED" }
  if let systemError = error as? SystemLanguageModel.Error, case .assetsUnavailable = systemError {
    return "ERR_AFM_UNAVAILABLE"
  }
  if let sessionError = error as? LanguageModelSession.Error {
    switch sessionError {
    case .concurrentRequests: return "ERR_AFM_BUSY"
    default: return "ERR_AFM_UNKNOWN"
    }
  }
  if let modelError = error as? LanguageModelError {
    switch modelError {
    case .guardrailViolation: return "ERR_AFM_GUARDRAIL"
    case .refusal: return "ERR_AFM_REFUSAL"
    case .contextSizeExceeded: return "ERR_AFM_CONTEXT"
    case .unsupportedLanguageOrLocale: return "ERR_AFM_LANGUAGE"
    case .rateLimited: return "ERR_AFM_BUSY"
    default: return "ERR_AFM_UNKNOWN"
    }
  }
  if let generation = error as? LanguageModelSession.GenerationError {
    switch generation {
    case .guardrailViolation: return "ERR_AFM_GUARDRAIL"
    case .refusal: return "ERR_AFM_REFUSAL"
    case .exceededContextWindowSize: return "ERR_AFM_CONTEXT"
    case .unsupportedLanguageOrLocale: return "ERR_AFM_LANGUAGE"
    case .assetsUnavailable: return "ERR_AFM_UNAVAILABLE"
    case .rateLimited, .concurrentRequests: return "ERR_AFM_BUSY"
    default: return "ERR_AFM_UNKNOWN"
    }
  }
  return "ERR_AFM_UNKNOWN"
}

private func reasonName(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
  switch reason {
  case .deviceNotEligible: return "deviceNotEligible"
  case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
  case .modelNotReady: return "modelNotReady"
  @unknown default: return "unknown"
  }
}

// ---- the request loop ----

private func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

private func handle(_ req: [String: Any]) async -> [String: Any] {
  let id = req["id"] as? String ?? ""
  let model = SystemLanguageModel.default
  if req["cmd"] as? String == "availability" {
    switch model.availability {
    case .available:
      return ["id": id, "available": true, "reason": NSNull(), "contextSize": model.contextSize]
    case .unavailable(let reason):
      return ["id": id, "available": false, "reason": reasonName(reason), "contextSize": NSNull()]
    }
  }
  guard case .available = model.availability else { return ["id": id, "error": "ERR_AFM_UNAVAILABLE"] }
  let instructions = req["instructions"] as? String ?? ""
  let prompt = req["prompt"] as? String ?? ""
  var options = GenerationOptions()
  options.temperature = req["temperature"] as? Double
  options.maximumResponseTokens = req["maxTokens"] as? Int
  let session = instructions.isEmpty
    ? LanguageModelSession(model: model)
    : LanguageModelSession(model: model, instructions: instructions)
  do {
    if let schemaJson = req["schema"] as? String {
      let generation = try schema(schemaJson)
      let response = try await session.respond(
        to: prompt, schema: generation, includeSchemaInPrompt: true, options: options)
      return ["id": id, "text": response.content.jsonString]
    }
    let response = try await session.respond(to: prompt, options: options)
    return ["id": id, "text": response.content]
  } catch {
    return ["id": id, "error": code(error)]
  }
}

while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
    emit(["id": "", "error": "ERR_BRIDGE_BAD_REQUEST"])
    continue
  }
  emit(await handle(req))
}
