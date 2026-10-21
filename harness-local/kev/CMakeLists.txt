# kev-decide: llama.rn's own C++ (node_modules/llama.rn, the vendored llama.cpp it pins and
# rn-decision.cpp) built for macOS with Metal, so the harness runs Kev through the exact code the
# phone runs. Built by harness-local/adapters/kev-local.ts into ~/.cache/mera-harness/kev-build.
# The definitions mirror node_modules/llama.rn/ios/CMakeLists.txt.
cmake_minimum_required(VERSION 3.16)
project(kev_decide LANGUAGES C CXX ASM OBJC)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif ()

set(LLAMA_RN_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../node_modules/llama.rn" CACHE PATH "llama.rn package")
include(${LLAMA_RN_DIR}/cmake/rnllama-sources.cmake)

add_definitions(
    -DNDEBUG
    -DGGML_USE_CPU
    -DGGML_USE_ACCELERATE
    -DGGML_USE_BLAS
    -DGGML_BLAS_USE_ACCELERATE
    -DGGML_USE_METAL
    -DGGML_METAL_EMBED_LIBRARY=1
    -DGGMLMetalClass=KevDecideGGMLMetalClass
)

add_executable(kev-decide
    main.cpp
    ${RNLLAMA_CORE_SOURCES}
    ${RNLLAMA_GGML_METAL_SOURCES}
    ${RNLLAMA_GGML_BLAS_SOURCES}
    ${RNLLAMA_GGML_CPU_ARCH_DIR}/arm/quants.c
    ${RNLLAMA_GGML_CPU_ARCH_DIR}/arm/repack.cpp
)
target_include_directories(kev-decide PRIVATE ${RNLLAMA_INCLUDE_DIRS})
target_link_libraries(kev-decide PRIVATE
    "-framework Accelerate" "-framework Foundation" "-framework Metal" "-framework MetalKit")
