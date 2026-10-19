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
#if canImport(FoundationModels)
import FoundationModels
#endif

internal final class OnDeviceLlmException: Exception {
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
    // Built with Xcode 27 or later, the framework throws LanguageModelError on
    // iOS 27 and GenerationError (deprecated in 27) on iOS 26. The iOS 26 SDK
    // has no LanguageModelError, hence the compile-time guard: Xcode 27 ships
    // Swift 6.4, every Xcode 26 release ships 6.3 or earlier.
    #if compiler(>=6.4)
    if #available(iOS 27.0, *), let modelError = error as? LanguageModelError {
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

  private func setStream(_ id: String, _ task: Task<Void, Never>?) {
    streamsLock.lock()
    streams[id] = task
    streamsLock.unlock()
  }

  private func takeStream(_ id: String) -> Task<Void, Never>? {
    streamsLock.lock()
    defer { streamsLock.unlock() }
    return streams.removeValue(forKey: id)
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
          let reason: Any = !appSupported
            ? "appLanguageNotSupported"
            : (!deviceSupported ? "deviceLanguageNotSupported" : NSNull())
          return [
            "available": appSupported && deviceSupported,
            "reason": reason,
            "appLanguageSupported": appSupported,
            "deviceLanguageSupported": deviceSupported,
          ]
        case .unavailable(let reason):
          return ["available": false, "reason": Afm.reason(reason)]
        @unknown default:
          return ["available": false, "reason": "unknown"]
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

    // Streams deltas as `onToken { id, delta }`, then `onDone { id }` or
    // `onError { id, code }`. The framework's stream yields cumulative snapshots;
    // only the new suffix is sent, cut on unicode scalars: a snapshot can end
    // inside a grapheme cluster (a combining mark, a flag, an emoji modifier),
    // and a Character count or hasPrefix would then stall the rest of the reply.
    Function("startStream") { (id: String, instructions: String, prompt: String, args: GenerationArgs) in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        let task = Task { [weak self] in
          var sentScalars = 0
          do {
            // Held for the whole loop: the docs do not say the stream retains
            // its session, and a released local could end the stream early.
            let session = Afm.session(instructions)
            defer { withExtendedLifetime(session) {} }
            let stream = session.streamResponse(to: prompt, options: Afm.options(args))
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
            self?.sendEvent("onError", ["id": id, "code": Afm.map(error).code])
          }
          _ = self?.takeStream(id)
        }
        setStream(id, task)
        return
      }
      #endif
      sendEvent("onError", ["id": id, "code": "ERR_AFM_UNAVAILABLE"])
    }

    Function("cancel") { (id: String) in
      takeStream(id)?.cancel()
    }
  }
}
