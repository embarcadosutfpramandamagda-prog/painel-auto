/*
 * test_icm_timing.cpp - Google Test de tempo real: o src/tasks.c rodando no
 * núcleo OSEK simulado (sim/osek_sil.c) com a configuração do oil/icm.oil.
 *
 * Cobre a parte "Timing, deadline, and fault-handling tests" do Projeto 2 e os
 * Verification Checks do slide: períodos, prazos, frescor, timeout de CAN,
 * proteção do recurso e atualização determinística do painel.
 */
#include <gtest/gtest.h>
#include <algorithm>
#include <cstring>
#include <set>
#include <vector>

extern "C" {
#include "osek_sil.h"
#include "icm_sil_run.h"
#include "icm_tasks.h"
#include "icm_data.h"
#include "can_types.h"
}

namespace {

/* uma execução de 10 s do carro andando sem falha (rodada uma vez e reaproveitada) */
struct Nominal {
    ICM_SilRun_t run;
    Nominal() {
        ICM_SilOptions_t o; ICM_SilDefaultOptions(&o);
        o.seconds = 10; o.verbose = 0; o.scenario = 0; o.trace_window_ms = 2000;
        ICM_SilRun(&o, &run);
    }
    ~Nominal() { ICM_SilFree(&run); }
};
Nominal &nominal() { static Nominal n; return n; }

const ICM_SilCheck_t *check(const ICM_SilRun_t &r, const char *name) {
    for (int i = 0; i < r.n_checks; i++) if (!std::strcmp(r.checks[i].name, name)) return &r.checks[i];
    return nullptr;
}

}  // namespace

/* ---------- a configuração do SIL é a do .oil ---------- */

TEST(OilConfig, PrioritiesAndPeriodsMatchOil) {
    EXPECT_EQ(SIL_PROCS[ISR2_CAN].priority, 20);
    EXPECT_TRUE(SIL_PROCS[ISR2_CAN].is_isr);
    EXPECT_EQ(SIL_PROCS[Task_CAN_RX].priority, 10);
    EXPECT_TRUE(SIL_PROCS[Task_CAN_RX].extended);
    EXPECT_TRUE(SIL_PROCS[Task_CAN_RX].autostart);
    EXPECT_EQ(SIL_PROCS[Task_Acquisition].period_ms, 10u);
    EXPECT_EQ(SIL_PROCS[Task_Processing].period_ms, 20u);
    EXPECT_EQ(SIL_PROCS[Task_Display].period_ms, 50u);
    EXPECT_EQ(SIL_PROCS[Task_Diagnostics].period_ms, 100u);
    EXPECT_EQ(SIL_PROCS[Task_Logging].period_ms, 1000u);
    EXPECT_EQ(SIL_RESOURCE_CEILING, 10) << "teto = maior prioridade entre quem usa o ICM_Resource";
}

/* ---------- Task Periods ---------- */

TEST(Timing, TaskPeriodsAreExact) {
    const ICM_SilRun_t &r = nominal().run;
    const struct { int id; uint32_t n, T; } exp[] = {
        {Task_Acquisition, 999, 10}, {Task_Processing, 499, 20}, {Task_Display, 199, 50},
        {Task_Diagnostics, 99, 100}, {Task_Logging, 9, 1000} };
    for (const auto &e : exp) {
        const SIL_Stats_t &s = r.res.stats[e.id];
        EXPECT_EQ(s.releases, e.n) << SIL_PROCS[e.id].name;
        EXPECT_EQ(s.jobs, e.n) << SIL_PROCS[e.id].name;
        EXPECT_EQ(s.min_period_us, e.T * 1000u) << SIL_PROCS[e.id].name;
        EXPECT_EQ(s.max_period_us, e.T * 1000u) << SIL_PROCS[e.id].name;
    }
    const ICM_TaskCounters_t *c = ICM_Counters();
    EXPECT_EQ(c->acquisition, 999u);
    EXPECT_EQ(c->display, 199u);
}

/* ---------- Deadline Compliance + RTA ---------- */

TEST(Timing, NoDeadlineMissAndMeasuredWithinAnalyticBound) {
    const ICM_SilRun_t &r = nominal().run;
    for (int p = 0; p < SIL_PROC_COUNT; p++) {
        const SIL_Stats_t &s = r.res.stats[p];
        EXPECT_EQ(s.missed, 0u) << SIL_PROCS[p].name;
        EXPECT_EQ(s.lost_activations, 0u) << SIL_PROCS[p].name;
        EXPECT_LE(s.max_resp_us, SIL_DEADLINE_US(p)) << SIL_PROCS[p].name;
        EXPECT_LE((double)s.max_resp_us, r.rta[p].R_us + 0.5) << SIL_PROCS[p].name << ": a análise tem que cobrir o medido";
    }
    EXPECT_LT(r.U_total, 0.10);
}

TEST(Timing, RTR01_CanFrameDecodedWithin2ms) {
    const ICM_SilRun_t &r = nominal().run;
    EXPECT_GT(r.m1_decoded, 15u);
    EXPECT_LT(r.can_latency_max_us, 2000u);
    EXPECT_EQ(r.m1_decoded, r.m1_sent) << "nenhum frame perdido sem falha";
    EXPECT_EQ(r.m2_decoded, r.m2_sent);
}

/* ---------- Scheduler: prioridade, preempção e estados ---------- */

TEST(Scheduler, JobsReleasedTogetherRunInPriorityOrder) {
    const ICM_SilRun_t &r = nominal().run;
    /* no t = 1000 ms vencem todas as periódicas e chegam M1 e M2 juntos */
    std::vector<std::pair<uint32_t, int>> starts;
    for (uint32_t i = 0; i < r.res.jobs_len; i++)
        if (r.res.jobs[i].release_us == 1000000u) starts.push_back({r.res.jobs[i].start_us, r.res.jobs[i].proc});
    std::sort(starts.begin(), starts.end());
    std::vector<int> order;
    for (auto &s : starts) order.push_back(s.second);
    std::vector<int> expected = {ISR2_CAN, Task_CAN_RX, Task_Acquisition, Task_Processing, Task_Display, Task_Diagnostics, Task_Logging};
    ASSERT_EQ(order.size(), expected.size());
    for (size_t i = 0; i < order.size(); i++) EXPECT_EQ(order[i], expected[i]) << "posição " << i;
}

TEST(Scheduler, PreemptionByPriorityWithResourceRespected) {
    /* custos x8: a Task_Display passa a levar ~10 ms e é interrompida pela Task_Acquisition
       (prioridade maior) no tick seguinte, sem perder prazo e sem violar o recurso */
    ICM_SilOptions_t o; ICM_SilDefaultOptions(&o);
    o.seconds = 5; o.verbose = 0; o.scenario = 0; o.cost_scale = 8.0;
    ICM_SilRun_t r; ICM_SilRun(&o, &r);
    EXPECT_GT(r.res.stats[Task_Display].preemptions, 0u);
    EXPECT_EQ(r.res.stats[Task_Acquisition].preemptions, 0u) << "ninguém de prioridade menor interrompe a Acquisition";
    for (int p = 0; p < SIL_PROC_COUNT; p++) EXPECT_EQ(r.res.stats[p].missed, 0u) << SIL_PROCS[p].name;
    EXPECT_EQ(r.res.resource_violations, 0u);
    EXPECT_LE(r.res.max_resource_holders, 1u);
    EXPECT_EQ(r.res.api_errors, 0u);
    ICM_SilFree(&r);
}

TEST(Scheduler, NominalLoadHasNoResourceErrors) {
    const ICM_SilRun_t &r = nominal().run;
    EXPECT_EQ(r.res.resource_violations, 0u);
    EXPECT_LE(r.res.max_resource_holders, 1u);
    EXPECT_EQ(r.res.api_errors, 0u);
}

TEST(Scheduler, OnlyExtendedTaskEverWaits) {
    const ICM_SilRun_t &r = nominal().run;
    std::set<int> waited;
    bool can_rx_suspended = false;
    for (uint32_t i = 0; i < r.res.trace_len; i++) {
        if (r.res.trace[i].state == SIL_WAITING) waited.insert(r.res.trace[i].proc);
        if (r.res.trace[i].proc == Task_CAN_RX && r.res.trace[i].state == SIL_SUSPENDED) can_rx_suspended = true;
    }
    EXPECT_EQ(waited.size(), 1u);
    EXPECT_TRUE(waited.count(Task_CAN_RX));
    EXPECT_FALSE(can_rx_suspended) << "Task_CAN_RX nunca termina: alterna Running <-> Waiting";
}

TEST(Scheduler, TaskStateSequenceSuspendedReadyRunning) {
    const ICM_SilRun_t &r = nominal().run;
    int last[SIL_PROC_COUNT]; for (int &x : last) x = SIL_SUSPENDED;
    int bad = 0;
    for (uint32_t i = 0; i < r.res.trace_len; i++) {
        int p = r.res.trace[i].proc, s = r.res.trace[i].state;
        /* transições válidas do OSEK */
        bool ok = (last[p] == SIL_SUSPENDED && s == SIL_READY) || (last[p] == SIL_READY && s == SIL_RUNNING) ||
                  (last[p] == SIL_RUNNING && (s == SIL_READY || s == SIL_SUSPENDED || s == SIL_WAITING)) ||
                  (last[p] == SIL_WAITING && s == SIL_READY);
        if (!ok) bad++;
        last[p] = s;
    }
    EXPECT_EQ(bad, 0);
    EXPECT_GT(r.res.trace_len, 1000u);
}

/* ---------- Deterministic Dashboard Update + Data Freshness ---------- */

TEST(Dashboard, UpdatesEvery50msAndIsDeterministic) {
    const ICM_SilRun_t &a = nominal().run;
    EXPECT_EQ(a.display_interval_min, 50u);
    EXPECT_EQ(a.display_interval_max, 50u);
    ICM_SilOptions_t o; ICM_SilDefaultOptions(&o);
    o.seconds = 10; o.verbose = 0; o.scenario = 0; o.trace_window_ms = 2000;
    ICM_SilRun_t b; ICM_SilRun(&o, &b);
    EXPECT_EQ(a.res.trace_hash, b.res.trace_hash) << "mesma entrada, mesmo trace";
    ICM_SilFree(&b);
}

TEST(Dashboard, DataFreshness) {
    const ICM_SilRun_t &r = nominal().run;
    EXPECT_LE(r.max_m1_age_ok_ms, CAN_M1_PERIOD_MS);
    EXPECT_LE(r.max_m2_age_ok_ms, CAN_M2_PERIOD_MS);
}

/* ---------- roteiro de falhas (demonstração de 30 s) ---------- */

TEST(FaultHandling, DemoScenarioEveryFaultDetectedInTime) {
    ICM_SilOptions_t o; ICM_SilDefaultOptions(&o);
    o.verbose = 0;
    ICM_SilRun_t r; ICM_SilRun(&o, &r);
    EXPECT_EQ(r.n_faults, 9);
    for (int i = 0; i < r.n_faults; i++)
        EXPECT_TRUE(r.faults[i].ok) << r.faults[i].what << " -> " << r.faults[i].expect
                                     << " detectada em " << (r.faults[i].detected_ms - r.faults[i].injected_ms) << " ms";
    for (int i = 0; i < r.n_checks; i++) EXPECT_TRUE(r.checks[i].ok) << r.checks[i].name << ": " << r.checks[i].detail;
    ICM_Data_t d; ICM_GetDataCopy(&d);
    EXPECT_TRUE(d.dtc_history & DTC_U0100);
    EXPECT_TRUE(d.dtc_history & DTC_U0101);
    EXPECT_TRUE(d.dtc_history & DTC_U0401);
    EXPECT_TRUE(d.dtc_history & DTC_P0115);
    EXPECT_TRUE(d.dtc_history & DTC_P0460);
    EXPECT_GT(r.rejected, 0u) << "os 9999 rpm foram descartados";
    ICM_SilFree(&r);
}

/* ---------- teste negativo: o detector acusa quando a CPU não dá conta ---------- */

TEST(Overload, DeadlineMissesAreDetected) {
    ICM_SilOptions_t o; ICM_SilDefaultOptions(&o);
    o.seconds = 5; o.verbose = 0; o.scenario = 0; o.cost_scale = 30.0;
    ICM_SilRun_t r; ICM_SilRun(&o, &r);
    uint32_t misses = 0, lost = 0;
    for (int p = 0; p < SIL_PROC_COUNT; p++) { misses += r.res.stats[p].missed; lost += r.res.stats[p].lost_activations; }
    EXPECT_GT(misses, 0u);
    EXPECT_GT(lost, 0u) << "ActivateTask com a anterior rodando = E_OS_LIMIT";
    EXPECT_GT(r.U_total, 1.0);
    ASSERT_TRUE(check(r, "Deadline Compliance") != nullptr);
    EXPECT_FALSE(check(r, "Deadline Compliance")->ok);
    EXPECT_FALSE(check(r, "Schedulability (RTA)")->ok);
    EXPECT_EQ(r.res.resource_violations, 0u) << "mesmo sobrecarregado o teto de prioridade segura o recurso";
    ICM_SilFree(&r);
}
