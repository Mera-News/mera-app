// Play Integrity (classic request) bindings for device sign-in.
//
// Deliberately thin: the nonce comes from the server, the token goes back to
// the server, and every verdict decision is the server's. Classic requests are
// the right shape here — sign-in is infrequent and high-value, which is
// Google's own guidance for classic over standard requests.
//
// isSupported() fails closed on emulators: Play Integrity on an emulator
// either fails outright or returns an unevaluated verdict the server must
// reject, so reporting "unsupported" up front routes the dev-bypass /
// email path instead of a guaranteed dead end.
package news.mera.deviceattest

import android.os.Build
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal class AttestUnsupportedException :
  CodedException("ERR_ATTEST_UNSUPPORTED", "Play Integrity is not supported on this device", null)

internal class IntegrityRequestFailedException(cause: Throwable?) :
  CodedException(
    "ERR_ATTEST_INTEGRITY_FAILED",
    "Play Integrity token request failed: ${cause?.message ?: "unknown"}",
    cause,
  )

private fun isProbablyEmulator(): Boolean {
  return Build.FINGERPRINT.startsWith("generic") ||
    Build.FINGERPRINT.contains("emulator", ignoreCase = true) ||
    Build.MODEL.contains("Emulator", ignoreCase = true) ||
    Build.MODEL.contains("sdk_gphone", ignoreCase = true) ||
    Build.PRODUCT.contains("sdk_gphone", ignoreCase = true) ||
    Build.HARDWARE.contains("goldfish", ignoreCase = true) ||
    Build.HARDWARE.contains("ranchu", ignoreCase = true)
}

class MeraDeviceAttestModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MeraDeviceAttest")

    AsyncFunction("isSupported") {
      !isProbablyEmulator()
    }

    // `cloudProjectNumber` may be null (env unset) — then the request is built
    // without one and the Play Console's linked project applies.
    AsyncFunction("requestIntegrityToken") { nonce: String, cloudProjectNumber: String?, promise: Promise ->
      if (isProbablyEmulator()) {
        promise.reject(AttestUnsupportedException())
        return@AsyncFunction
      }
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.reject(IntegrityRequestFailedException(null))
        return@AsyncFunction
      }
      try {
        val manager = IntegrityManagerFactory.create(context)
        val builder = IntegrityTokenRequest.builder().setNonce(nonce)
        cloudProjectNumber?.toLongOrNull()?.let { builder.setCloudProjectNumber(it) }
        manager
          .requestIntegrityToken(builder.build())
          .addOnSuccessListener { response -> promise.resolve(response.token()) }
          .addOnFailureListener { e -> promise.reject(IntegrityRequestFailedException(e)) }
      } catch (e: Throwable) {
        promise.reject(IntegrityRequestFailedException(e))
      }
    }
  }
}
