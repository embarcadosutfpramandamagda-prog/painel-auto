# Build e testes do ICM no PC (sem placa):
#   cmake -B build && cmake --build build && ctest --test-dir build --output-on-failure
#   ./build/icm_sil                      painel no terminal, 30 s de roteiro com falhas
#   cmake --build build --target evidencias   gera docs/evidencias/ (relatório de temporização)
#
# O GoogleTest é baixado na configuração (FetchContent). Sem internet, use
#   cmake -B build -DICM_GTEST_OFFLINE=ON
# que troca pelo cabeçalho mínimo compatível de tests/gtest_offline/.
cmake_minimum_required(VERSION 3.16)
project(TrampolineICM C CXX)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
add_compile_options(-Wall -Wextra)

option(ICM_GTEST_OFFLINE "usar o gtest mínimo de tests/gtest_offline (sem internet)" OFF)
find_package(Threads REQUIRED)
find_package(Python3 COMPONENTS Interpreter)

# --- lógica do painel (com mutex do pthread no lugar do ICM_Resource) ---
add_library(icm_core STATIC src/icm_data.c src/icm_display.c)
target_include_directories(icm_core PUBLIC include)
target_link_libraries(icm_core PUBLIC Threads::Threads m)

# --- firmware completo (src/tasks.c) no núcleo OSEK simulado ---
add_library(icm_sil_lib STATIC
  src/icm_data.c src/icm_display.c src/vehicle_sim.c src/tasks.c
  sim/osek_sil.c sim/icm_sil_cfg.c sim/icm_sil_run.c)
target_include_directories(icm_sil_lib PUBLIC include sim)
target_compile_definitions(icm_sil_lib PUBLIC ICM_SIL _DEFAULT_SOURCE)
target_link_libraries(icm_sil_lib PUBLIC m)

add_executable(icm_sil sim/icm_sil_main.c)
target_link_libraries(icm_sil PRIVATE icm_sil_lib)

# --- harness antigo (make test) ---
add_executable(test_icm tests/test_icm.c)
target_link_libraries(test_icm PRIVATE icm_core)

# --- GoogleTest ---
if(ICM_GTEST_OFFLINE)
  add_library(gtest_main_offline STATIC tests/gtest_offline/gtest_main.cpp)
  target_include_directories(gtest_main_offline PUBLIC tests/gtest_offline)
  set(GTEST_LIBS gtest_main_offline)
else()
  include(FetchContent)
  FetchContent_Declare(googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.tar.gz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
  set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)
  set(GTEST_LIBS GTest::gtest_main)
endif()

add_executable(test_icm_gtest tests/gtest/test_icm_logic.cpp)
target_link_libraries(test_icm_gtest PRIVATE icm_core ${GTEST_LIBS} Threads::Threads)

add_executable(test_timing_gtest tests/gtest/test_icm_timing.cpp)
target_link_libraries(test_timing_gtest PRIVATE icm_sil_lib ${GTEST_LIBS})

# --- ctest ---
enable_testing()
add_test(NAME Harness_C COMMAND test_icm)
add_test(NAME GTest_Logica COMMAND test_icm_gtest --gtest_output=xml:${CMAKE_BINARY_DIR}/test-results/logica.xml)
add_test(NAME GTest_TempoReal COMMAND test_timing_gtest --gtest_output=xml:${CMAKE_BINARY_DIR}/test-results/tempo_real.xml)
add_test(NAME SIL_Roteiro30s COMMAND icm_sil --quiet)
if(Python3_FOUND)
  add_test(NAME OIL_igual_SIL COMMAND ${Python3_EXECUTABLE} ${CMAKE_SOURCE_DIR}/tools/oil2sil.py --check)
endif()

# relatório de temporização, trace e linha do tempo em docs/evidencias
# e web/js/evidencias.js (aba VERIFICAÇÕES da bancada do site)
add_custom_target(evidencias
  COMMAND icm_sil --report ${CMAKE_SOURCE_DIR}/docs/evidencias
  COMMAND ${Python3_EXECUTABLE} ${CMAKE_SOURCE_DIR}/tools/evid2web.py ${CMAKE_BINARY_DIR}
  DEPENDS icm_sil test_icm test_icm_gtest test_timing_gtest
  COMMENT "gerando docs/evidencias e web/js/evidencias.js")
