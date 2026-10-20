// Gemini Nano bindings (ML Kit GenAI Prompt API on AICore): the phone's
// built-in model as Mera's second on-device text engine on Android.
//
// Everything runs on the device. AICore serves the model locally; the client
// pins the STABLE release stage, never a preview model.
//
// Mirrors the Swift module: stateless calls, the same events and the same
// internal ERR_AFM_* codes, so JS has one contract for both platforms. Error
// messages never carry prompt or output text and exceptions carry no cause.
// ML Kit needs API 26; the app's minSdk is 24, so every entry point checks
// SDK_INT before the Nano class (the only ML Kit user) is touched.
package news.mera.ondevicellm

import android.os.Build
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.ModelReleaseStage
import com.google.mlkit.genai.prompt.SystemInstruction
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generationConfig
import com.google.mlkit.genai.prompt.modelConfig
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

internal class OnDeviceLlmException(code: String, message: String) : CodedException(code, message, null)

private fun unavailable() = OnDeviceLlmException("ERR_AFM_UNAVAILABLE", "The on-device built-in model is not available")

private fun map(error: Throwable): OnDeviceLlmException {
  if (error is OnDeviceLlmException) return error
  if (error is CancellationException) return OnDeviceLlmException("ERR_AFM_CANCELLED", "The request was cancelled")
  if (error !is GenAiException) return OnDeviceLlmException("ERR_AFM_UNKNOWN", "The on-device built-in model failed")
  return when (error.errorCode) {
    GenAiException.ErrorCode.BUSY,
    GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED,
    GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED -> OnDeviceLlmException("ERR_AFM_BUSY", "The model is busy")
    GenAiException.ErrorCode.REQUEST_TOO_LARGE ->
      OnDeviceLlmException("ERR_AFM_CONTEXT", "The request exceeds the model's context window")
    GenAiException.ErrorCode.CANCELLED -> OnDeviceLlmException("ERR_AFM_CANCELLED", "The request was cancelled")
    GenAiException.ErrorCode.NOT_AVAILABLE,
    GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE,
    GenAiException.ErrorCode.AICORE_INCOMPATIBLE,
    GenAiException.ErrorCode.NOT_SUPPORTED -> unavailable()
    else -> OnDeviceLlmException("ERR_AFM_UNKNOWN", "The on-device built-in model failed")
  }
}

class GenerationArgs : Record {
  @Field val temperature: Double? = null
  @Field val maxTokens: Int? = null
}

private fun unavailableBecause(reason: String): Map<String, Any?> = mapOf("available" to false, "reason" to reason)

// The only class that touches ML Kit, created on API 26+ only.
private class Nano(private val scope: CoroutineScope) {
  val model: GenerativeModel = run {
    val stable = modelConfig { releaseStage = ModelReleaseStage.STABLE }
    Generation.getClient(generationConfig { modelConfig = stable })
  }
  private var systemPrompt: Boolean? = null
  @Volatile private var download: Job? = null

  // AVAILABLE runs; DOWNLOADABLE starts AICore's download in the background
  // and reports modelNotReady until it lands. An unlocked bootloader reports
  // a non-GenAI error code, so anything but NEEDS_SYSTEM_UPDATE is ineligible.
  suspend fun availability(): Map<String, Any?> = try {
    when (model.checkStatus()) {
      FeatureStatus.AVAILABLE -> mapOf("available" to true, "reason" to null)
      FeatureStatus.DOWNLOADABLE -> {
        startDownload()
        unavailableBecause("modelNotReady")
      }
      FeatureStatus.DOWNLOADING -> unavailableBecause("modelNotReady")
      else -> unavailableBecause("deviceNotEligible")
    }
  } catch (e: CancellationException) {
    throw e
  } catch (e: GenAiException) {
    unavailableBecause(if (e.errorCode == GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE) "needsSystemUpdate" else "deviceNotEligible")
  } catch (e: Exception) {
    unavailableBecause("deviceNotEligible")
  }

  @Synchronized private fun startDownload() {
    if (download?.isActive == true) return
    download = scope.launch {
      try {
        model.download().collect {}
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        // The next availability() call retries.
      }
    }
  }

  suspend fun contextSize(): Int? = try {
    if (model.checkStatus() == FeatureStatus.AVAILABLE) model.getTokenLimit() else null
  } catch (e: CancellationException) {
    throw e
  } catch (e: Exception) {
    null
  }

  // A system instruction needs Nano v3 or later; older models get the
  // instructions in front of the prompt instead.
  suspend fun request(instructions: String, prompt: String, args: GenerationArgs): GenerateContentRequest {
    val useSystem = instructions.isNotEmpty() &&
      (systemPrompt ?: model.isSystemPromptAvailable().also { systemPrompt = it })
    val builder = when {
      useSystem -> GenerateContentRequest.Builder(SystemInstruction(instructions), TextPart(prompt))
      instructions.isEmpty() -> GenerateContentRequest.Builder(TextPart(prompt))
      else -> GenerateContentRequest.Builder(TextPart("$instructions\n\n$prompt"))
    }
    builder.temperature = args.temperature?.toFloat()
    builder.maxOutputTokens = args.maxTokens
    return builder.build()
  }

  suspend fun respond(instructions: String, prompt: String, args: GenerationArgs): String =
    model.generateContent(request(instructions, prompt, args)).candidates.firstOrNull()?.text ?: ""
}

class MeraOnDeviceLlmModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val nanoLazy = lazy { Nano(scope) }
  private val streams = ConcurrentHashMap<String, Job>()

  private val supported get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O

  private fun nano(): Nano {
    if (!supported) throw unavailable()
    return nanoLazy.value
  }

  override fun definition() = ModuleDefinition {
    Name("MeraOnDeviceLlm")

    Events("onToken", "onDone", "onError")

    // { available, reason }. Not cached: AICore can finish downloading while
    // the app runs. Nano publishes no language list, so `appLanguage` is not
    // checked here.
    AsyncFunction("availability") Coroutine { _: String ->
      if (!supported) unavailableBecause("osTooOld") else nano().availability()
    }

    // Context window in tokens, null until the model can run.
    AsyncFunction("contextSize") Coroutine { ->
      if (!supported) null else nano().contextSize()
    }

    // Best effort. warmup() takes no instructions, so they are ignored here.
    Function("prewarm") { _: String ->
      if (supported) {
        scope.launch {
          try {
            nano().model.warmup()
          } catch (e: Exception) {
            // Best effort only.
          }
        }
      }
    }

    AsyncFunction("respond") Coroutine { instructions: String, prompt: String, args: GenerationArgs ->
      try {
        nano().respond(instructions, prompt, args)
      } catch (e: Throwable) {
        throw map(e)
      }
    }

    // No guided generation on Nano (structured output is a separate alpha
    // artifact): the schema goes into the prompt and JS extracts and
    // validates the JSON from the raw text.
    AsyncFunction("respondStructured") Coroutine { instructions: String, prompt: String, schemaJson: String, args: GenerationArgs ->
      try {
        nano().respond(instructions, "$prompt\n\nReply with only JSON matching this schema: $schemaJson", args)
      } catch (e: Throwable) {
        throw map(e)
      }
    }

    // Streams `onToken { id, delta }` (ML Kit chunks are already deltas),
    // then `onDone { id }` or `onError { id, code }`. A cancelled stream ends
    // with ERR_AFM_CANCELLED. Started lazily so the job is registered before
    // it can finish and remove itself.
    Function("startStream") { id: String, instructions: String, prompt: String, args: GenerationArgs ->
      if (!supported) {
        sendEvent("onError", mapOf("id" to id, "code" to "ERR_AFM_UNAVAILABLE"))
        return@Function
      }
      val job = scope.launch(start = CoroutineStart.LAZY) {
        try {
          val nano = nano()
          nano.model.generateContentStream(nano.request(instructions, prompt, args)).collect { chunk ->
            val delta = chunk.candidates.firstOrNull()?.text
            if (!delta.isNullOrEmpty()) sendEvent("onToken", mapOf("id" to id, "delta" to delta))
          }
          ensureActive()
          sendEvent("onDone", mapOf("id" to id))
        } catch (e: Throwable) {
          val code = if (!isActive) "ERR_AFM_CANCELLED" else map(e).code
          sendEvent("onError", mapOf("id" to id, "code" to code))
        } finally {
          streams.remove(id)
        }
      }
      streams[id] = job
      job.start()
    }

    Function("cancel") { id: String ->
      streams.remove(id)?.cancel()
    }

    // The JS runtime is going away: stop every stream and release the client.
    OnDestroy {
      streams.values.forEach { it.cancel() }
      streams.clear()
      scope.cancel()
      if (nanoLazy.isInitialized()) nanoLazy.value.model.close()
    }
  }
}
