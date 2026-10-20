// kev-decide: one Kev context, decide() over JSONL on stdin/stdout.
//
//   kev-decide <model.gguf>
//   in : {"id":"1","request":{"state":...,"questions":...}}   (the TypeSafe /v1/systemone body)
//   out: {"id":"1","result":{model,answers,usage},"ms":123}    or {"id":"1","error":"..."}
//   The first line out is {"ready":true,"model":...} once the model is loaded.
//
// The context is built the way the app builds it (lib/mera-protocol-toolkit/core/modelManager.ts
// initParamsFor, run through llama.rn's JSIParams parseCommonParams), and every request goes
// through llama_rn_context::decide(), the same function the phone's context.decide() calls.
// Logs go to stderr.

#include "rn-llama.h"

#include <chrono>
#include <iostream>
#include <string>

int main(int argc, char ** argv) {
    if (argc < 2) {
        std::cerr << "usage: kev-decide <model.gguf>\n";
        return 2;
    }
    std::ios::sync_with_stdio(false);

    // initParamsFor(RELEVANCE_MODEL): n_ctx 4096, n_gpu_layers 999, n_threads 4, mmap,
    // n_batch 4096, flash attention on, f16 KV. Everything else keeps common_params' defaults,
    // as parseCommonParams leaves it.
    common_params cparams;
    cparams.fit_params      = false;
    cparams.model.path      = argv[1];
    cparams.n_ctx           = 4096;
    cparams.n_batch         = 4096;
    cparams.n_gpu_layers    = 999;
    cparams.cpuparams.n_threads = 4;
    cparams.load_mode       = LLAMA_LOAD_MODE_MMAP;
    cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;
    cparams.cache_type_k    = GGML_TYPE_F16;
    cparams.cache_type_v    = GGML_TYPE_F16;

    llama_backend_init();
    rnllama::llama_rn_context ctx;
    if (!ctx.loadModel(cparams)) {
        std::cout << json{{"ready", false}, {"error", "failed to load the model"}}.dump() << std::endl;
        return 1;
    }
    if (!ctx.decision.is_decision_model()) {
        std::cout << json{{"ready", false}, {"error", "not a decision model"}}.dump() << std::endl;
        return 1;
    }
    std::cout << json{{"ready", true}, {"model", ctx.modelName()},
                               {"type", rnllama::llama_rn_decision_type_name(ctx.decision.type)}}.dump()
              << std::endl;

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        json out;
        try {
            const auto msg = json::parse(line);
            out["id"] = msg.value("id", json());
            const auto t0 = std::chrono::steady_clock::now();
            out["result"] = ctx.decide(msg.at("request"));
            out["ms"] = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - t0).count();
        } catch (const std::exception & e) {
            out["error"] = e.what();
        }
        std::cout << out.dump() << std::endl;
    }
    return 0;
}
