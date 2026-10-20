// Apple Foundation Models bindings: the on-device Apple Intelligence text model
// as Mera's second on-device text engine.
//
// Everything runs on the device. `SystemLanguageModel.default` is the on-device
// model; this module never selects a server model or Private Cloud Compute.
//
// Deliberately thin and stateless: every call builds a fresh
// LanguageModelSession from the caller's instructions and prompt (the app
// already assembles the whole turn), so there is no transcript to manage and no
// `concurrentRequests` from reusing one session. Error messages never carry
// prompt or output text; JS branches on the stable `ERR_AFM_*` codes.

import ExpoModulesCore
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

internal final class OnDeviceLlmException: Exception, @unchecked Sendable {
  private let codeValue: String
  private let reasonValue: String

  init(_ code: String, _ reason: String) {
    self.codeValue = code
    self.reasonValue = reason
    super.init()
  }

  override var code: String { codeValue }
  override var reason: String { reasonValue }
}

private func unavailableException() -> OnDeviceLlmException {
  OnDeviceLlmException("ERR_AFM_UNAVAILABLE", "The on-device Apple model is not available")
}

private func schemaException() -> OnDeviceLlmException {
  OnDeviceLlmException("ERR_AFM_UNKNOWN", "The output schema is not supported")
}

// A JSON value that keeps object keys in source order (see Afm.schema).
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

  // After an element: true on a comma, false on the closing bracket.
  private mutating func more(_ close: UInt8) throws -> Bool {
    skipSpace()
    guard i < bytes.count else { throw schemaException() }
    i += 1
    if bytes[i - 1] == UInt8(ascii: ",") { return true }
    if bytes[i - 1] == close { return false }
    throw schemaException()
  }

  private mutating func isEmpty(_ close: UInt8) -> Bool {
    skipSpace()
    guard i < bytes.count, bytes[i] == close else { return false }
    i += 1
    return true
  }

  // One value and nothing after it.
  mutating func document() throws -> Json {
    let root = try value()
    skipSpace()
    guard i == bytes.count else { throw schemaException() }
    return root
  }

  mutating func value() throws -> Json {
    skipSpace()
    guard i < bytes.count else { throw schemaException() }
    switch bytes[i] {
    case UInt8(ascii: "{"):
      i += 1
      var fields: [(String, Json)] = []
      if isEmpty(UInt8(ascii: "}")) { return .object(fields) }
      repeat {
        guard case .string(let key) = try value() else { throw schemaException() }
        skipSpace()
        guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { throw schemaException() }
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
      // Find the closing quote, then let JSONSerialization decode the escapes.
      let start = i
      i += 1
      while i < bytes.count, bytes[i] != UInt8(ascii: "\"") { i += bytes[i] == UInt8(ascii: "\\") ? 2 : 1 }
      guard i < bytes.count else { throw schemaException() }
      i += 1
      let decoded = try? JSONSerialization.jsonObject(with: Data(bytes[start..<i]), options: .fragmentsAllowed)
      guard let text = decoded as? String else { throw schemaException() }
      return .string(text)
    default:
      let start = i
      while i < bytes.count, !",]} \n\r\t".utf8.contains(bytes[i]) { i += 1 }
      let token = String(decoding: bytes[start..<i], as: UTF8.self)
      if token == "true" || token == "false" || token == "null" { return .literal }
      guard let number = Double(token) else { throw schemaException() }
      return .number(number)
    }
  }
}

internal struct GenerationArgs: Record {
  @Field var temperature: Double? = nil
  @Field var maxTokens: Int? = nil
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
private enum Afm {
  static func session(_ instructions: String) -> LanguageModelSession {
    instructions.isEmpty
      ? LanguageModelSession(model: SystemLanguageModel.default)
      : LanguageModelSession(model: SystemLanguageModel.default, instructions: instructions)
  }

  static func options(_ args: GenerationArgs) -> GenerationOptions {
    var options = GenerationOptions()
    options.temperature = args.temperature
    options.maximumResponseTokens = args.maxTokens
    return options
  }

  // The JSON Schema subset the app sends (object with properties + required,
  // string with optional enum, integer, number, boolean, array with items and
  // minItems/maxItems) as a guided-generation schema. Read with JsonReader
  // because the model fills properties in schema order and both
  // JSONSerialization and GeneratedContent(json:) lose the key order. Every
  // object and enum is named by its path, so names never collide.
  static func schema(_ json: String) throws -> GenerationSchema {
    var reader = JsonReader(json)
    let root = try reader.document()
    return try GenerationSchema(root: node(root, path: "root"), dependencies: [])
  }

  private static func node(_ json: Json, path: String) throws -> DynamicGenerationSchema {
    let description = json["description"]?.string
    switch json["type"]?.string {
    case "object":
      guard case .object(let properties)? = json["properties"] else { throw schemaException() }
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
      guard let items = json["items"] else { throw schemaException() }
      return DynamicGenerationSchema(
        arrayOf: try node(items, path: "\(path)[]"),
        minimumElements: json["minItems"]?.int,
        maximumElements: json["maxItems"]?.int
      )
    default:
      throw schemaException()
    }
  }

  static func reason(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
    switch reason {
    case .deviceNotEligible: return "deviceNotEligible"
    case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
    case .modelNotReady: return "modelNotReady"
    @unknown default: return "unknown"
    }
  }

  static func map(_ error: Error) -> OnDeviceLlmException {
    if error is CancellationError {
      return OnDeviceLlmException("ERR_AFM_CANCELLED", "The request was cancelled")
    }
    // Built with Xcode 27 or later, the framework throws LanguageModelError,
    // SystemLanguageModel.Error and LanguageModelSession.Error on iOS 27, and
    // GenerationError (deprecated in 27) on iOS 26. The iOS 26 SDK has none of
    // the three, hence the compile-time guard: Xcode 27 ships Swift 6.4, every
    // Xcode 26 release ships 6.3 or earlier.
    #if compiler(>=6.4)
    if #available(iOS 27.0, *) {
      if let systemError = error as? SystemLanguageModel.Error, case .assetsUnavailable = systemError {
        return unavailableException()
      }
      if let sessionError = error as? LanguageModelSession.Error {
        switch sessionError {
        case .concurrentRequests:
          return OnDeviceLlmException("ERR_AFM_BUSY", "The model is busy")
        default:
          return OnDeviceLlmException("ERR_AFM_UNKNOWN", "The on-device Apple model failed")
        }
      }
      if let modelError = error as? LanguageModelError {
        switch modelError {
        case .guardrailViolation:
          return OnDeviceLlmException("ERR_AFM_GUARDRAIL", "Apple's safety guardrails declined the request")
        case .refusal:
          return OnDeviceLlmException("ERR_AFM_REFUSAL", "The model declined the request")
        case .contextSizeExceeded:
          return OnDeviceLlmException("ERR_AFM_CONTEXT", "The request exceeds the model's context window")
        case .unsupportedLanguageOrLocale:
          return OnDeviceLlmException("ERR_AFM_LANGUAGE", "The model does not support this language")
        case .rateLimited:
          return OnDeviceLlmException("ERR_AFM_BUSY", "The model is busy")
        default:
          return OnDeviceLlmException("ERR_AFM_UNKNOWN", "The on-device Apple model failed")
        }
      }
    }
    #endif
    if let generation = error as? LanguageModelSession.GenerationError {
      switch generation {
      case .guardrailViolation:
        return OnDeviceLlmException("ERR_AFM_GUARDRAIL", "Apple's safety guardrails declined the request")
      case .refusal:
        return OnDeviceLlmException("ERR_AFM_REFUSAL", "The model declined the request")
      case .exceededContextWindowSize:
        return OnDeviceLlmException("ERR_AFM_CONTEXT", "The request exceeds the model's context window")
      case .unsupportedLanguageOrLocale:
        return OnDeviceLlmException("ERR_AFM_LANGUAGE", "The model does not support this language")
      case .assetsUnavailable:
        return unavailableException()
      case .rateLimited, .concurrentRequests:
        return OnDeviceLlmException("ERR_AFM_BUSY", "The model is busy")
      default:
        return OnDeviceLlmException("ERR_AFM_UNKNOWN", "The on-device Apple model failed")
      }
    }
    return OnDeviceLlmException("ERR_AFM_UNKNOWN", "The on-device Apple model failed")
  }
}
#endif

public class MeraOnDeviceLlmModule: Module {
  private var streams: [String: Task<Void, Never>] = [:]
  private let streamsLock = NSLock()

  private func takeStream(_ id: String) -> Task<Void, Never>? {
    streamsLock.lock()
    defer { streamsLock.unlock() }
    return streams.removeValue(forKey: id)
  }

  private func takeAllStreams() -> [Task<Void, Never>] {
    streamsLock.lock()
    defer { streamsLock.unlock() }
    let running = Array(streams.values)
    streams.removeAll()
    return running
  }

  public func definition() -> ModuleDefinition {
    Name("MeraOnDeviceLlm")

    Events("onToken", "onDone", "onError")

    // { available, reason, appLanguageSupported, deviceLanguageSupported }.
    // `reason` is null when available, else one of deviceNotEligible |
    // appleIntelligenceNotEnabled | modelNotReady | appLanguageNotSupported |
    // deviceLanguageNotSupported | osTooOld | unknown. Cheap and never cached:
    // modelNotReady and appleIntelligenceNotEnabled change while the app runs.
    // `appLanguage` is Mera's in-app language tag (it can differ from the
    // device locale), checked with the framework's own fallback rules.
    AsyncFunction("availability") { (appLanguage: String) -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
          let appSupported = model.supportsLocale(Locale(identifier: appLanguage))
          let deviceSupported = model.supportsLocale(Locale.current)
          let reason: Any
          if !appSupported {
            reason = "appLanguageNotSupported"
          } else if !deviceSupported {
            reason = "deviceLanguageNotSupported"
          } else {
            reason = NSNull()
          }
          return [
            "available": appSupported && deviceSupported,
            "reason": reason,
            "appLanguageSupported": appSupported,
            "deviceLanguageSupported": deviceSupported,
          ]
        case .unavailable(let reason):
          return ["available": false, "reason": Afm.reason(reason)]
        }
      }
      #endif
      return ["available": false, "reason": "osTooOld"]
    }

    // Best effort: loads the model's resources ahead of a request.
    Function("prewarm") { (instructions: String) in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        Afm.session(instructions).prewarm()
      }
      #endif
    }

    AsyncFunction("respond") { (instructions: String, prompt: String, args: GenerationArgs) async throws -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        do {
          let response = try await Afm.session(instructions).respond(to: prompt, options: Afm.options(args))
          return response.content
        } catch {
          throw Afm.map(error)
        }
      }
      #endif
      throw unavailableException()
    }

    // Guided generation: the reply is constrained to `schemaJson` (the subset
    // Afm.schema reads) and returned as JSON text.
    AsyncFunction("respondStructured") { (instructions: String, prompt: String, schemaJson: String, args: GenerationArgs) async throws -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        let schema: GenerationSchema
        do {
          schema = try Afm.schema(schemaJson)
        } catch {
          throw schemaException()
        }
        do {
          let response = try await Afm.session(instructions).respond(
            to: prompt, schema: schema, includeSchemaInPrompt: true, options: Afm.options(args))
          return response.content.jsonString
        } catch {
          throw Afm.map(error)
        }
      }
      #endif
      throw unavailableException()
    }

    // Context window in tokens (input plus output), null when the model cannot
    // run. Below iOS 27 the framework answers a fixed 4096. The property is
    // back-deployed but missing from SDKs before 26.4, so it is compiled only
    // with the Xcode 27 toolchain (Swift 6.4); older toolchains answer null.
    AsyncFunction("contextSize") { () -> Int? in
      #if canImport(FoundationModels) && compiler(>=6.4)
      if #available(iOS 26.0, *) {
        let model = SystemLanguageModel.default
        if case .available = model.availability { return model.contextSize }
      }
      #endif
      return nil
    }

    // Streams deltas as `onToken { id, delta }`, then `onDone { id }` or
    // `onError { id, code }`. The framework's stream yields cumulative snapshots;
    // only the new suffix is sent, cut on unicode scalars: a snapshot can end
    // inside a grapheme cluster (a combining mark, a flag, an emoji modifier),
    // and a Character count or hasPrefix would then stall the rest of the reply.
    Function("startStream") { [weak self] (id: String, instructions: String, prompt: String, args: GenerationArgs) in
      guard let self else { return }
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        let options = Afm.options(args)
        // Registered under the lock the task's own clean-up takes, so a stream
        // that fails at once cannot remove its entry before it is stored.
        streamsLock.lock()
        defer { streamsLock.unlock() }
        streams[id] = Task { [weak self] in
          var sentScalars = 0
          do {
            // Held for the whole loop: the docs do not say the stream retains
            // its session, and a released local could end the stream early.
            let session = Afm.session(instructions)
            defer { withExtendedLifetime(session) {} }
            let stream = session.streamResponse(to: prompt, options: options)
            for try await snapshot in stream {
              let scalars = snapshot.content.unicodeScalars
              let count = scalars.count
              if count > sentScalars {
                let delta = String(String.UnicodeScalarView(scalars.dropFirst(sentScalars)))
                sentScalars = count
                self?.sendEvent("onToken", ["id": id, "delta": delta])
              }
            }
            try Task.checkCancellation()
            self?.sendEvent("onDone", ["id": id])
          } catch {
            // A cancel() or OnDestroy may surface as a framework error rather
            // than CancellationError; JS still expects ERR_AFM_CANCELLED.
            let code = Task.isCancelled ? "ERR_AFM_CANCELLED" : Afm.map(error).code
            self?.sendEvent("onError", ["id": id, "code": code])
          }
          _ = self?.takeStream(id)
        }
        return
      }
      #endif
      sendEvent("onError", ["id": id, "code": "ERR_AFM_UNAVAILABLE"])
    }

    Function("cancel") { (id: String) in
      takeStream(id)?.cancel()
    }

    // The JS runtime is going away (reload or teardown): stop every stream so
    // none keeps the model busy for a listener that no longer exists.
    OnDestroy {
      takeAllStreams().forEach { $0.cancel() }
    }
  }
}
