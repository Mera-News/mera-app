// DCAppAttestService bindings for device sign-in.
//
// Deliberately thin: every hash is computed in JS (expo-crypto) and every
// verification decision is the server's. This module only moves base64 across
// the bridge and maps DCError codes to stable, typed error codes the JS layer
// can branch on — ERR_ATTEST_INVALID_KEY in particular, which is the "key
// vanished after reinstall, restart enrollment" signal.
//
// isSupported() is the simulator gate: DCAppAttestService.isSupported is false
// on simulators and on unsupported hardware, and every other function fails
// closed to ERR_ATTEST_UNSUPPORTED rather than crashing.

import DeviceCheck
import ExpoModulesCore

internal final class AttestUnsupportedException: Exception {
  override var code: String { "ERR_ATTEST_UNSUPPORTED" }
  override var reason: String { "App Attest is not supported on this device" }
}

internal final class AttestInvalidKeyException: Exception {
  override var code: String { "ERR_ATTEST_INVALID_KEY" }
  override var reason: String { "The App Attest key is invalid or no longer exists" }
}

internal final class AttestInvalidInputException: Exception {
  override var code: String { "ERR_ATTEST_INVALID_INPUT" }
  override var reason: String { "Invalid input passed to App Attest" }
}

internal final class AttestServerUnavailableException: Exception {
  override var code: String { "ERR_ATTEST_SERVER_UNAVAILABLE" }
  override var reason: String { "Apple's attestation service is unavailable" }
}

internal final class AttestUnknownException: Exception {
  override var code: String { "ERR_ATTEST_UNKNOWN" }
  override var reason: String { "App Attest failed with an unknown error" }
}

private func mapDCError(_ error: Error) -> Exception {
  let nsError = error as NSError
  guard nsError.domain == DCErrorDomain, let code = DCError.Code(rawValue: nsError.code) else {
    return AttestUnknownException()
  }
  switch code {
  case .invalidKey:
    return AttestInvalidKeyException()
  case .invalidInput:
    return AttestInvalidInputException()
  case .featureUnsupported:
    return AttestUnsupportedException()
  case .serverUnavailable:
    return AttestServerUnavailableException()
  default:
    return AttestUnknownException()
  }
}

public class MeraDeviceAttestModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MeraDeviceAttest")

    AsyncFunction("isSupported") { () -> Bool in
      return DCAppAttestService.shared.isSupported
    }

    AsyncFunction("generateKey") { (promise: Promise) in
      guard DCAppAttestService.shared.isSupported else {
        promise.reject(AttestUnsupportedException())
        return
      }
      DCAppAttestService.shared.generateKey { keyId, error in
        if let error = error {
          promise.reject(mapDCError(error))
        } else if let keyId = keyId {
          promise.resolve(keyId)
        } else {
          promise.reject(AttestUnknownException())
        }
      }
    }

    // `challengeBase64` is the base64 of SHA256(nonce), computed in JS —
    // DCAppAttestService.attestKey takes the client-data hash directly.
    AsyncFunction("attestKey") { (keyId: String, challengeBase64: String, promise: Promise) in
      guard DCAppAttestService.shared.isSupported else {
        promise.reject(AttestUnsupportedException())
        return
      }
      guard let clientDataHash = Data(base64Encoded: challengeBase64) else {
        promise.reject(AttestInvalidInputException())
        return
      }
      DCAppAttestService.shared.attestKey(keyId, clientDataHash: clientDataHash) { attestation, error in
        if let error = error {
          promise.reject(mapDCError(error))
        } else if let attestation = attestation {
          promise.resolve(attestation.base64EncodedString())
        } else {
          promise.reject(AttestUnknownException())
        }
      }
    }

    // `clientDataHashBase64` is the base64 of SHA256(clientData JSON), computed
    // in JS. Rejects with ERR_ATTEST_INVALID_KEY when the stored key no longer
    // exists (reinstall, migration, restore) — the caller clears the stored
    // keyId and restarts enrollment.
    AsyncFunction("generateAssertion") { (keyId: String, clientDataHashBase64: String, promise: Promise) in
      guard DCAppAttestService.shared.isSupported else {
        promise.reject(AttestUnsupportedException())
        return
      }
      guard let clientDataHash = Data(base64Encoded: clientDataHashBase64) else {
        promise.reject(AttestInvalidInputException())
        return
      }
      DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: clientDataHash) { assertion, error in
        if let error = error {
          promise.reject(mapDCError(error))
        } else if let assertion = assertion {
          promise.resolve(assertion.base64EncodedString())
        } else {
          promise.reject(AttestUnknownException())
        }
      }
    }
  }
}
