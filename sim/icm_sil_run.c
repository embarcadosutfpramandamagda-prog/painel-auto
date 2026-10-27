/*
 * icm_sil_run.c - executa o ICM no SIL, confere os requisitos e escreve as evidências.
 */
#include "icm_sil_run.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdarg.h>
#include "icm_data.h"
#include "icm_display.h"
#include "icm_tasks.h"
#include "vehicle_sim.h"

/* --- ligação com o "hardware" simulado --- */
static bool g_irq;
static ICM_SilRun_t *g_run;
static uint32_t g_last_frame_no, g_last_frame_t;
static uint16_t g_prev_flags;
static const VSim_Event_t *g_scn; static unsigned g_scn_n;

/* tem falha de CAN ligada (ou acabou de desligar) perto deste instante? */
static bool can_disturbed(uint32_t ms) {
    for (unsigned i = 0; i < g_scn_n; i++) {
        const VSim_Event_t *e = &g_scn[i];
        if (!(e->mask & (VS_CAN_MUTE | VS_M2_MUTE | VS_RPM_GARBAGE | VS_ENGINE_OFF))) continue;
        /* janela: do começo da falha até 2,5 s depois do fim */
        uint32_t end = e->at_ms;
        for (unsigned j = i + 1; j < g_scn_n; j++)
            if (g_scn[j].mask & e->mask) { end = g_scn[j].at_ms; break; }
        if (end == e->at_ms) end = 0xFFFFFFFFu;     /* nunca desligou */
        if (ms >= e->at_ms && ms <= (end == 0xFFFFFFFFu ? end : end + 2500u)) return true;
    }
    return false;
}

static void on_tick(uint32_t ms) {
    ICM_SetNowMs(ms);
    /* observa o painel antes de andar o "carro" (o que as tarefas do ms anterior deixaram) */
    const ICM_DisplayFrame_t *f = ICM_LastFrame();
    if (f && f->frame_no != g_last_frame_no) {
        if (g_last_frame_no) {
            uint32_t iv = f->time_ms - g_last_frame_t;
            if (!g_run->display_interval_min || iv < g_run->display_interval_min) g_run->display_interval_min = iv;
            if (iv > g_run->display_interval_max) g_run->display_interval_max = iv;
        }
        g_last_frame_no = f->frame_no; g_last_frame_t = f->time_ms;
        g_run->frames_display++;
        if (f->time_ms >= 1500u && !can_disturbed(f->time_ms)) {
            if (f->m1_age_ms > g_run->max_m1_age_ok_ms) g_run->max_m1_age_ok_ms = f->m1_age_ms;
            if (f->m2_age_ms > g_run->max_m2_age_ok_ms) g_run->max_m2_age_ok_ms = f->m2_age_ms;
        }
    }
    ICM_Data_t d;
    ICM_GetDataCopy(&d);
    if (ms % 50u == 0u && g_run->n_samples < g_run->opt.seconds * 20u) {
        uint32_t k = g_run->n_samples++;
        g_run->s_speed[k] = d.vehicle_speed_kmh; g_run->s_rpm[k] = d.engine_rpm;
        g_run->s_fuel[k] = d.fuel_level_percent; g_run->s_temp[k] = d.coolant_temp_celsius;
        g_run->s_flags[k] = d.warning_flags;
    }
    g_irq = VSim_Step1ms(ms);
}

static bool hw_irq(uint32_t ms) { (void)ms; return g_irq; }

/* --- falhas esperadas do roteiro: o que deve acender e em quanto tempo --- */
typedef struct { uint32_t mask_event; const char *what; const char *expect; uint16_t flag; uint32_t limit_ms; } Expect_t;
static const Expect_t EXPECT[] = {
    { VS_CAN_MUTE,    "barramento CAN mudo",        "U0100 + MIL + rpm 0 (RS-01)",      FLAG_CAN_M1_TIMEOUT, CAN_M1_TIMEOUT_MS + 600u },
    { VS_CAN_MUTE,    "barramento CAN mudo",        "U0101 + MIL + velocidade 0 (RS-02)", FLAG_CAN_M2_TIMEOUT, CAN_M2_TIMEOUT_MS + 1100u },
    { VS_RPM_GARBAGE, "ECM manda 9999 rpm",         "descarta, U0401 + MIL (RS-05)",    FLAG_SIGNAL_OOR,     CAN_M1_PERIOD_MS + 100u },
    { VS_TEMP_OPEN,   "sensor de temperatura solto","P0115 + MIL",                      FLAG_TEMP_SENSOR,    100u },
    { VS_FUEL_OPEN,   "sensor de combustível solto","P0460 + MIL",                      FLAG_FUEL_SENSOR,    100u },
    { VS_FAN_FAIL,    "ventoinha queimou",          "luz TEMP em >= 115 °C (RS-03)",    FLAG_COOLANT_HOT,    4000u },
    { VS_BELT_OFF,    "cinto solto",                "luz do cinto (RF-08)",             FLAG_SEATBELT_WARN,  100u },
    { VS_ENGINE_OFF,  "motor desligado",            "luzes de óleo e bateria (RF-08)",  FLAG_OIL_PRESS_LOW,  CAN_M1_PERIOD_MS + 100u },
    { VS_HANDBRAKE,   "freio de mão puxado",        "luz do freio (RF-08)",             FLAG_HANDBRAKE_ON,   CAN_M2_PERIOD_MS + 100u },
};
#define N_EXPECT (sizeof(EXPECT) / sizeof(EXPECT[0]))

void ICM_SilDefaultOptions(ICM_SilOptions_t *o) {
    o->seconds = 30; o->cost_scale = 1.0; o->verbose = 1; o->scenario = 1; o->trace_window_ms = 1100;
}

/* análise de tempo de resposta (RTA) com bloqueio pelo teto do recurso */
static void rta(ICM_SilRun_t *r) {
    double U = 0.0;
    for (int i = 0; i < SIL_PROC_COUNT; i++) {
        const SIL_ProcCfg_t *c = &SIL_PROCS[i];
        double k = r->opt.cost_scale;
        uint32_t T = c->period_ms ? c->period_ms * 1000u : CAN_M1_PERIOD_MS * 1000u;  /* CAN: chega no máx. a cada 500 ms */
        double C = c->cost_us * k;
        int pi = c->is_isr ? 1000 + c->priority : c->priority;
        double B = 0.0;
        if (!c->is_isr)
            for (int j = 0; j < SIL_PROC_COUNT; j++)
                if (!SIL_PROCS[j].is_isr && SIL_PROCS[j].priority < c->priority && SIL_PROCS[j].uses_resource)
                    if (SIL_PROCS[j].cs_us * k > B) B = SIL_PROCS[j].cs_us * k;
        double R = C + B, prev = -1.0;
        for (int it = 0; it < 100 && R != prev && R < 10.0 * T; it++) {
            prev = R;
            double sum = C + B;
            for (int j = 0; j < SIL_PROC_COUNT; j++) {
                if (j == i) continue;
                const SIL_ProcCfg_t *h = &SIL_PROCS[j];
                int pj = h->is_isr ? 1000 + h->priority : h->priority;
                if (pj <= pi) continue;
                uint32_t Tj = h->period_ms ? h->period_ms * 1000u : CAN_M1_PERIOD_MS * 1000u;
                sum += ceil(R / Tj) * h->cost_us * k;
            }
            R = sum;
        }
        r->rta[i].R_us = R; r->rta[i].B_us = B; r->rta[i].T_us = T; r->rta[i].U = C / T;
        U += C / T;
    }
    r->U_total = U;
}

static void add_check(ICM_SilRun_t *r, const char *name, bool ok, const char *fmt, ...) {
    if (r->n_checks >= ICM_SIL_MAX_CHECKS) return;
    ICM_SilCheck_t *c = &r->checks[r->n_checks++];
    c->name = name; c->ok = ok;
    va_list ap; va_start(ap, fmt); vsnprintf(c->detail, sizeof(c->detail), fmt, ap); va_end(ap);
    if (!ok) r->checks_failed++;
}

static uint32_t first_flag_after(const ICM_SilRun_t *r, uint16_t flag, uint32_t from_ms) {
    for (uint32_t k = 0; k < r->n_samples; k++)
        if (k * 50u >= from_ms && (r->s_flags[k] & flag)) return k * 50u;
    return 0;
}

void ICM_SilRun(const ICM_SilOptions_t *o, ICM_SilRun_t *r) {
    memset(r, 0, sizeof(*r));
    r->opt = *o;
    uint32_t ns = o->seconds * 20u + 1u;
    r->s_speed = (float *)calloc(ns, sizeof(float)); r->s_rpm = (float *)calloc(ns, sizeof(float));
    r->s_fuel = (float *)calloc(ns, sizeof(float)); r->s_temp = (float *)calloc(ns, sizeof(float));
    r->s_flags = (uint16_t *)calloc(ns, sizeof(uint16_t));
    g_run = r; g_last_frame_no = 0; g_last_frame_t = 0; g_prev_flags = 0; g_irq = false;

    ICM_TasksInit(o->verbose);
    VSim_Init();
    g_scn = NULL; g_scn_n = 0;
    if (o->scenario) { g_scn = VSim_DemoScenario(&g_scn_n); VSim_SetScenario(g_scn, g_scn_n); }

    SIL_Config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.duration_ms = o->seconds * 1000u;
    cfg.cost_scale = o->cost_scale;
    cfg.record_trace = true;
    cfg.trace_window_ms = o->trace_window_ms;
    cfg.on_tick = on_tick;
    cfg.hw_irq = hw_irq;
    SIL_Run(&cfg, &r->res);

    r->m1_sent = VSim_FramesSent(CAN_ID_M1_ENGINE); r->m2_sent = VSim_FramesSent(CAN_ID_M2_VEHICLE);
    ICM_Data_t d; ICM_GetDataCopy(&d);
    r->m1_decoded = d.frames_m1; r->m2_decoded = d.frames_m2; r->rejected = d.frames_rejected;

    /* latência: interrupção do CAN -> Task_CAN_RX terminou de decodificar */
    uint32_t last_isr = 0; bool have = false;
    for (uint32_t i = 0; i < r->res.jobs_len; i++) {
        const SIL_Job_t *j = &r->res.jobs[i];
        if (j->proc == ISR2_CAN) { last_isr = j->release_us; have = true; }
        else if (j->proc == Task_CAN_RX && have && j->release_us >= last_isr) {
            uint32_t lat = j->finish_us - last_isr;
            if (lat > r->can_latency_max_us) r->can_latency_max_us = lat;
            have = false;
        }
    }

    rta(r);

    /* falhas do roteiro: quando cada uma foi detectada */
    if (o->scenario) {
        for (unsigned e = 0; e < N_EXPECT && r->n_faults < ICM_SIL_MAX_FAULTS; e++) {
            uint32_t at = 0; bool found = false;
            for (unsigned i = 0; i < g_scn_n; i++)
                if (g_scn[i].mask & EXPECT[e].mask_event) {
                    const VSim_Faults_t *s = &g_scn[i].set;
                    bool on = (EXPECT[e].mask_event == VS_CAN_MUTE && s->can_mute) || (EXPECT[e].mask_event == VS_RPM_GARBAGE && s->rpm_garbage) ||
                              (EXPECT[e].mask_event == VS_TEMP_OPEN && s->temp_sensor_open) || (EXPECT[e].mask_event == VS_FUEL_OPEN && s->fuel_sensor_open) ||
                              (EXPECT[e].mask_event == VS_FAN_FAIL && s->fan_failure) || (EXPECT[e].mask_event == VS_BELT_OFF && s->seatbelt_off) ||
                              (EXPECT[e].mask_event == VS_ENGINE_OFF && s->engine_off) || (EXPECT[e].mask_event == VS_HANDBRAKE && s->handbrake);
                    if (on) { at = g_scn[i].at_ms; found = true; break; }
                }
            if (!found || at >= o->seconds * 1000u) continue;
            ICM_SilFault_t *x = &r->faults[r->n_faults++];
            x->what = EXPECT[e].what; x->expect = EXPECT[e].expect; x->injected_ms = at; x->limit_ms = EXPECT[e].limit_ms;
            x->detected_ms = first_flag_after(r, EXPECT[e].flag, at);
            x->ok = x->detected_ms && (x->detected_ms - at) <= x->limit_ms;
        }
    }

    /* --- os "Verification Checks" do slide --- */
    uint32_t misses = 0, lost = 0;
    for (int p = 0; p < SIL_PROC_COUNT; p++) { misses += r->res.stats[p].missed; lost += r->res.stats[p].lost_activations; }
    bool periods = true; char pd[160] = "";
    for (int p = 0; p < SIL_PROC_COUNT; p++) {
        const SIL_ProcCfg_t *c = &SIL_PROCS[p];
        if (!c->period_ms) continue;
        uint32_t expect_n = (o->seconds * 1000u - c->offset_ms + c->period_ms - 1u) / c->period_ms;
        const SIL_Stats_t *st = &r->res.stats[p];
        if (st->releases != expect_n || st->min_period_us != c->period_ms * 1000u || st->max_period_us != c->period_ms * 1000u) {
            periods = false;
            snprintf(pd, sizeof(pd), "%s: %u ativações (esperado %u), período %u..%u us", c->name,
                     st->releases, expect_n, st->min_period_us, st->max_period_us);
        }
    }
    if (periods) snprintf(pd, sizeof(pd), "10/20/50/100/1000 ms exatos em todas as ativações");

    int n_fault_ok = 0; for (int i = 0; i < r->n_faults; i++) n_fault_ok += r->faults[i].ok;
    bool functional = r->m1_decoded + r->rejected >= r->m1_decoded && r->n_faults == n_fault_ok;

    add_check(r, "Functional Correctness", functional,
              "%d de %d reações de falha corretas; %u frames M1 e %u M2 decodificados", n_fault_ok, r->n_faults, r->m1_decoded, r->m2_decoded);
    add_check(r, "Task Periods", periods, "%s", pd);
    add_check(r, "Deadline Compliance", misses == 0, "%u prazos perdidos, %u ativações perdidas (E_OS_LIMIT)", misses, lost);
    add_check(r, "Data Freshness", !o->scenario || (r->max_m1_age_ok_ms <= CAN_M1_PERIOD_MS + 60u && r->max_m2_age_ok_ms <= CAN_M2_PERIOD_MS + 60u),
              "idade máx. no painel: M1 %u ms (período 500), M2 %u ms (período 1000)", r->max_m1_age_ok_ms, r->max_m2_age_ok_ms);
    bool can_ok = true;
    for (int i = 0; i < r->n_faults; i++) if (strstr(r->faults[i].expect, "U010") && !r->faults[i].ok) can_ok = false;
    if (r->can_latency_max_us > 2000u) can_ok = false;        /* RTR-01 */
    add_check(r, "CAN Timeout Handling", can_ok, "U0100 após >1000 ms sem M1, U0101 após >2000 ms sem M2, valor seguro 0; latência ISR->decodificado %u us (RTR-01 < 2 ms)", r->can_latency_max_us);
    add_check(r, "Resource Protection", r->res.resource_violations == 0 && r->res.max_resource_holders <= 1 && r->res.api_errors == 0,
              "teto %d; %u violações de teto, %u erros de API, no máx. %u tarefa dentro do ICM_Resource",
              SIL_RESOURCE_CEILING, r->res.resource_violations, r->res.api_errors, r->res.max_resource_holders);
    add_check(r, "Deterministic Dashboard Update", r->display_interval_min == 50u && r->display_interval_max == 50u,
              "%u quadros, intervalo %u..%u ms; hash do trace %016llx", r->frames_display, r->display_interval_min,
              r->display_interval_max, (unsigned long long)r->res.trace_hash);
    int worst = -1;
    for (int p = 0; p < SIL_PROC_COUNT; p++) if (r->rta[p].R_us > SIL_DEADLINE_US(p)) { worst = p; break; }
    if (worst < 0)
        add_check(r, "Schedulability (RTA)", r->U_total <= 1.0, "utilização %.2f %%; pior resposta analítica dentro do prazo em todas", r->U_total * 100.0);
    else
        add_check(r, "Schedulability (RTA)", false, "utilização %.2f %%; %s: R = %.0f us > prazo %u us", r->U_total * 100.0,
                  SIL_PROCS[worst].name, r->rta[worst].R_us, SIL_DEADLINE_US(worst));
}

void ICM_SilPrintSummary(const ICM_SilRun_t *r, FILE *f) {
    fprintf(f, "\n=== ICM no núcleo OSEK simulado: %u s, custo x%.1f ===\n", r->opt.seconds, r->opt.cost_scale);
    fprintf(f, "%-17s %4s %6s %7s %8s %9s %9s %6s %6s\n", "tarefa", "prio", "T(ms)", "ativ.", "C(us)", "R an.(us)", "R máx(us)", "perdas", "preemp");
    for (int p = 0; p < SIL_PROC_COUNT; p++) {
        const SIL_ProcCfg_t *c = &SIL_PROCS[p]; const SIL_Stats_t *s = &r->res.stats[p];
        fprintf(f, "%-17s %4d %6u %7u %8.0f %9.0f %9u %6u %6u\n", c->name, c->priority, c->period_ms, s->releases,
                c->cost_us * r->opt.cost_scale, r->rta[p].R_us, s->max_resp_us, s->missed, s->preemptions);
    }
    fprintf(f, "utilização analítica %.2f %%, CPU ocupada medida %.2f %%\n", r->U_total * 100.0,
            100.0 * (double)(r->res.total_us - r->res.idle_us) / (double)r->res.total_us);
    if (r->n_faults) {
        fprintf(f, "\nfalhas injetadas:\n");
        for (int i = 0; i < r->n_faults; i++)
            fprintf(f, "  %s %-28s t=%5u ms -> %-36s detectada em %u ms (limite %u)\n", r->faults[i].ok ? "[OK]  " : "[FALHA]",
                    r->faults[i].what, r->faults[i].injected_ms, r->faults[i].expect,
                    r->faults[i].detected_ms ? r->faults[i].detected_ms - r->faults[i].injected_ms : 0, r->faults[i].limit_ms);
    }
    fprintf(f, "\nverificações (slide do Projeto 2):\n");
    for (int i = 0; i < r->n_checks; i++)
        fprintf(f, "  %s %-31s %s\n", r->checks[i].ok ? "[OK]  " : "[FALHA]", r->checks[i].name, r->checks[i].detail);
    fprintf(f, "\nRESULTADO: %d de %d verificações OK\n", r->n_checks - r->checks_failed, r->n_checks);
}

/* ---------------- arquivos de evidência ---------------- */

static FILE *open_in(const char *dir, const char *name) {
    char path[512];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    FILE *f = fopen(path, "w");
    if (!f) fprintf(stderr, "não consegui escrever %s\n", path);
    return f;
}

static const char *COLORS[SIL_PROC_COUNT] = { "#e03131", "#f08c00", "#e8590c", "#d4a017", "#2f9e44", "#1971c2", "#7048e8" };

/* linha do tempo no estilo do slide: uma faixa por tarefa, marcas nas ativações e barras quando roda */
static void write_svg(const ICM_SilRun_t *r, const char *dir, const char *name, uint32_t from_ms, uint32_t to_ms, bool states) {
    FILE *f = open_in(dir, name);
    if (!f) return;
    const double W = 1100, left = 150, right = 20, laneH = 34, top = 50;
    double H = top + SIL_PROC_COUNT * laneH + 70;
    double sx = (W - left - right) / (double)((to_ms - from_ms) * 1000u);
    fprintf(f, "<svg xmlns='http://www.w3.org/2000/svg' width='%.0f' height='%.0f' font-family='Helvetica,Arial,sans-serif' font-size='12'>\n", W, H);
    fprintf(f, "<rect width='100%%' height='100%%' fill='#ffffff'/>\n");
    fprintf(f, "<text x='%.0f' y='22' font-size='16' font-weight='700' fill='#0b2a5b'>Comportamento OSEK/VDX do ICM (SIL) - %u a %u ms</text>\n", left, from_ms, to_ms);
    uint32_t step = (to_ms - from_ms) >= 500u ? 100u : ((to_ms - from_ms) >= 100u ? 10u : ((to_ms - from_ms) >= 20u ? 5u : 1u));
    for (uint32_t t = from_ms; t <= to_ms; t += step) {
        double x = left + (t - from_ms) * 1000.0 * sx;
        fprintf(f, "<line x1='%.1f' y1='%.0f' x2='%.1f' y2='%.0f' stroke='#dee2e6' stroke-dasharray='3,3'/>\n", x, top - 8, x, top + SIL_PROC_COUNT * laneH);
        fprintf(f, "<text x='%.1f' y='%.0f' text-anchor='middle' fill='#495057'>%u</text>\n", x, top - 12, t);
    }
    for (int p = 0; p < SIL_PROC_COUNT; p++) {
        const SIL_ProcCfg_t *c = &SIL_PROCS[p];
        double y = top + p * laneH;
        fprintf(f, "<text x='10' y='%.0f' fill='%s' font-weight='700'>%s</text>\n", y + 21, COLORS[p], c->name);
        if (c->period_ms) fprintf(f, "<text x='10' y='%.0f' fill='#868e96' font-size='10'>a cada %u ms, prio %d</text>\n", y + 32, c->period_ms, c->priority);
        else fprintf(f, "<text x='10' y='%.0f' fill='#868e96' font-size='10'>%s, prio %d</text>\n", y + 32, c->is_isr ? "interrupção" : "evento", c->priority);
        fprintf(f, "<line x1='%.0f' y1='%.0f' x2='%.0f' y2='%.0f' stroke='#ced4da'/>\n", left, y + 26, W - right, y + 26);
    }
    /* estados (READY claro, WAITING amarelo, RUNNING cheio) a partir do trace */
    int cur[SIL_PROC_COUNT]; uint32_t since[SIL_PROC_COUNT];
    for (int p = 0; p < SIL_PROC_COUNT; p++) { cur[p] = SIL_SUSPENDED; since[p] = 0; }
    for (uint32_t i = 0; i <= r->res.trace_len; i++) {
        uint32_t t = i < r->res.trace_len ? r->res.trace[i].t_us : to_ms * 1000u;
        int pp = i < r->res.trace_len ? r->res.trace[i].proc : -1;
        for (int p = 0; p < SIL_PROC_COUNT; p++) {
            if (pp >= 0 && p != pp) continue;
            uint32_t a = since[p], b = t;
            if (b > from_ms * 1000u && a < to_ms * 1000u && cur[p] != SIL_SUSPENDED) {
                if (a < from_ms * 1000u) a = from_ms * 1000u;
                if (b > to_ms * 1000u) b = to_ms * 1000u;
                double x = left + (a - from_ms * 1000.0) * sx, w = (b - a) * sx;
                if (w < 1.2) w = 1.2;
                double y = top + p * laneH;
                if (cur[p] == SIL_RUNNING)
                    fprintf(f, "<rect x='%.2f' y='%.0f' width='%.2f' height='16' fill='%s'/>\n", x, y + 10, w, COLORS[p]);
                else if (states && cur[p] == SIL_READY)
                    fprintf(f, "<rect x='%.2f' y='%.0f' width='%.2f' height='16' fill='%s' opacity='0.25'/>\n", x, y + 10, w, COLORS[p]);
                else if (states && cur[p] == SIL_WAITING)
                    fprintf(f, "<rect x='%.2f' y='%.0f' width='%.2f' height='4' fill='#fcc419' opacity='0.8'/>\n", x, y + 22, w);
            }
            if (pp >= 0) { cur[p] = r->res.trace[i].state; since[p] = t; }
        }
    }
    double ly = top + SIL_PROC_COUNT * laneH + 30;
    fprintf(f, "<rect x='%.0f' y='%.0f' width='14' height='10' fill='#495057'/><text x='%.0f' y='%.0f'>Running</text>\n", left, ly - 9, left + 20, ly);
    if (states) {
        fprintf(f, "<rect x='%.0f' y='%.0f' width='14' height='10' fill='#495057' opacity='0.25'/><text x='%.0f' y='%.0f'>Ready (esperando CPU / preemptada)</text>\n", left + 100, ly - 9, left + 120, ly);
        fprintf(f, "<rect x='%.0f' y='%.0f' width='14' height='4' fill='#fcc419'/><text x='%.0f' y='%.0f'>Waiting (Task_CAN_RX no WaitEvent)</text>\n", left + 360, ly - 5, left + 380, ly);
    }
    fprintf(f, "<text x='%.0f' y='%.0f' fill='#868e96' font-size='11'>Suspended -> Ready -> Running -> (Waiting) -> Ready. Preempção por prioridade, alarmes ativam as periódicas, ISR2_CAN acorda a Task_CAN_RX.</text>\n", left, ly + 22);
    fputs("</svg>\n", f);
    fclose(f);
}

void ICM_SilWriteReports(const ICM_SilRun_t *r, const char *dir) {
    FILE *f;
    /* trace de estados (janela) */
    if ((f = open_in(dir, "trace_estados.csv"))) {
        fputs("t_us,tarefa,estado\n", f);
        for (uint32_t i = 0; i < r->res.trace_len; i++)
            fprintf(f, "%u,%s,%s\n", r->res.trace[i].t_us, SIL_PROCS[r->res.trace[i].proc].name, SIL_StateName(r->res.trace[i].state));
        fclose(f);
    }
    /* todos os jobs */
    if ((f = open_in(dir, "jobs.csv"))) {
        fputs("tarefa,ativacao_us,inicio_us,fim_us,resposta_us,bloqueio_us,preempcoes,prazo_us,prazo_ok\n", f);
        for (uint32_t i = 0; i < r->res.jobs_len; i++) {
            const SIL_Job_t *j = &r->res.jobs[i];
            uint32_t resp = j->finish_us - j->release_us, dl = SIL_DEADLINE_US(j->proc);
            fprintf(f, "%s,%u,%u,%u,%u,%u,%u,%u,%s\n", SIL_PROCS[j->proc].name, j->release_us, j->start_us, j->finish_us,
                    resp, j->blocked_us, j->preemptions, dl, resp <= dl ? "sim" : "NAO");
        }
        fclose(f);
    }
    write_svg(r, dir, "linha_do_tempo_1s.svg", 0, r->opt.trace_window_ms < 1000u ? r->opt.trace_window_ms : 1000u, false);
    write_svg(r, dir, "linha_do_tempo_zoom.svg", 999, 1004, true);

    /* relatório em markdown */
    if ((f = open_in(dir, "RELATORIO_TEMPORIZACAO.md"))) {
        fprintf(f, "# Relatório de temporização e falhas - ICM (SIL)\n\n");
        fprintf(f, "Gerado por `build/icm_sil --report docs/evidencias` (sim/icm_sil_run.c). O firmware é o mesmo `src/tasks.c` "
                   "do Trampoline, rodando no núcleo OSEK simulado (`sim/osek_sil.c`), com a configuração tirada do "
                   "`oil/icm.oil` por `tools/oil2sil.py` e o tempo de CPU de `sim/wcet.csv`.\n\n");
        fprintf(f, "- Duração simulada: **%u s**, SystemCounter de 1 ms, custos x%.1f\n", r->opt.seconds, r->opt.cost_scale);
        fprintf(f, "- Roteiro de falhas: %s\n", r->opt.scenario ? "demonstração (`VSim_DemoScenario` em src/vehicle_sim.c)" : "nenhuma falha");
        fprintf(f, "- Hash do trace (FNV-1a): `%016llx` - rodar de novo dá o mesmo valor (determinismo)\n\n", (unsigned long long)r->res.trace_hash);

        fprintf(f, "## 1. Verificações do Projeto 2\n\n| Verificação | Resultado | Detalhe |\n| :--- | :---: | :--- |\n");
        for (int i = 0; i < r->n_checks; i++)
            fprintf(f, "| %s | %s | %s |\n", r->checks[i].name, r->checks[i].ok ? "OK" : "**FALHOU**", r->checks[i].detail);
        fprintf(f, "| Trace and Test Report | OK | este arquivo, `jobs.csv`, `trace_estados.csv`, `linha_do_tempo_*.svg` e o relatório dos testes |\n\n");

        fprintf(f, "## 2. Análise de escalonabilidade (RTA)\n\n");
        fprintf(f, "Prioridade fixa e preemptiva (OSEK `SCHEDULE = FULL`). Tempo de resposta no pior caso:\n\n"
                   "R<sub>i</sub> = C<sub>i</sub> + B<sub>i</sub> + Σ<sub>j ∈ hp(i)</sub> ⌈R<sub>i</sub> / T<sub>j</sub>⌉ · C<sub>j</sub>\n\n"
                   "onde B<sub>i</sub> é o maior trecho dentro do `ICM_Resource` de uma tarefa de prioridade menor "
                   "(com o teto de prioridade do OSEK, cada tarefa espera no máximo um trecho desses). "
                   "A ISR e a Task_CAN_RX entram com o intervalo mínimo entre frames (500 ms).\n\n");
        fprintf(f, "| Tarefa / ISR | Prio | T (ms) | C (µs) | Recurso (µs) | U | B (µs) | R analítico (µs) | Prazo (ms) | R medido máx (µs) | R médio (µs) | Ativações | Período medido (µs) | Perdas | Preempções |\n");
        fprintf(f, "| :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: |\n");
        for (int p = 0; p < SIL_PROC_COUNT; p++) {
            const SIL_ProcCfg_t *c = &SIL_PROCS[p]; const SIL_Stats_t *s = &r->res.stats[p];
            double mean = s->jobs ? (double)s->sum_resp_us / s->jobs : 0.0;
            char per[48];
            if (c->period_ms) snprintf(per, sizeof(per), "%u .. %u", s->min_period_us, s->max_period_us);
            else snprintf(per, sizeof(per), "%u .. %u (evento)", s->min_period_us, s->max_period_us);
            char Tcol[16];
            if (c->period_ms) snprintf(Tcol, sizeof(Tcol), "%u", c->period_ms); else snprintf(Tcol, sizeof(Tcol), "500*");
            fprintf(f, "| `%s` | %d | %s | %.0f | %.0f | %.4f | %.0f | %.0f | %u | %u | %.0f | %u | %s | %u | %u |\n",
                    c->name, c->priority, Tcol,
                    c->cost_us * r->opt.cost_scale, c->cs_us * r->opt.cost_scale, r->rta[p].U, r->rta[p].B_us, r->rta[p].R_us,
                    SIL_DEADLINE_US(p) / 1000u, s->max_resp_us, mean, s->releases, per, s->missed, s->preemptions);
        }
        fprintf(f, "\n\\* intervalo mínimo entre frames CAN (M1 a cada 500 ms).\n\n");
        fprintf(f, "- Utilização total U = **%.2f %%** (limite de Liu & Layland pra %d tarefas: %.1f %%)\n", r->U_total * 100.0,
                SIL_PROC_COUNT, 100.0 * SIL_PROC_COUNT * (pow(2.0, 1.0 / SIL_PROC_COUNT) - 1.0));
        fprintf(f, "- CPU ocupada medida na simulação: **%.2f %%**\n", 100.0 * (double)(r->res.total_us - r->res.idle_us) / (double)r->res.total_us);
        fprintf(f, "- Latência máxima frame CAN -> decodificado (ISR2_CAN + Task_CAN_RX): **%u µs** (RTR-01: < 2 ms)\n", r->can_latency_max_us);
        fprintf(f, "- Frames: M1 enviados %u / decodificados %u, M2 enviados %u / decodificados %u, rejeitados por faixa %u "
                   "(a diferença enviados x decodificados é o tempo com barramento mudo)\n\n",
                r->m1_sent, r->m1_decoded, r->m2_sent, r->m2_decoded, r->rejected);

        if (r->n_faults) {
            fprintf(f, "## 3. Falhas injetadas e reação do painel\n\n| t (ms) | Falha | Reação esperada | Detectada após (ms) | Limite (ms) | OK |\n| ---: | :--- | :--- | ---: | ---: | :---: |\n");
            for (int i = 0; i < r->n_faults; i++)
                fprintf(f, "| %u | %s | %s | %s%u | %u | %s |\n", r->faults[i].injected_ms, r->faults[i].what, r->faults[i].expect,
                        r->faults[i].detected_ms ? "" : "não detectou ", r->faults[i].detected_ms ? r->faults[i].detected_ms - r->faults[i].injected_ms : 0,
                        r->faults[i].limit_ms, r->faults[i].ok ? "sim" : "**não**");
            fprintf(f, "\nO limite já inclui o tempo do próprio requisito (ex.: 1000 ms sem M1) mais o período de quem detecta "
                       "(Task_Diagnostics, 100 ms) e o da amostra (50 ms).\n\n");
        }
        fprintf(f, "## 4. Linha do tempo\n\n![primeiro segundo](linha_do_tempo_1s.svg)\n\n"
                   "Zoom em t = 999..1004 ms (todas as tarefas vencem juntas no t = 1000 ms, com M1 e M2 chegando):\n\n"
                   "![zoom](linha_do_tempo_zoom.svg)\n");
        fclose(f);
    }

    /* resumo pro site (bancada de testes) */
    if ((f = open_in(dir, "sil_resumo.json"))) {
        fprintf(f, "{\n  \"segundos\": %u, \"hash\": \"%016llx\", \"utilizacao\": %.4f,\n  \"tarefas\": [\n", r->opt.seconds,
                (unsigned long long)r->res.trace_hash, r->U_total);
        for (int p = 0; p < SIL_PROC_COUNT; p++) {
            const SIL_ProcCfg_t *c = &SIL_PROCS[p]; const SIL_Stats_t *s = &r->res.stats[p];
            fprintf(f, "    {\"nome\":\"%s\",\"prio\":%d,\"periodo_ms\":%u,\"custo_us\":%u,\"ativacoes\":%u,\"r_max_us\":%u,\"r_rta_us\":%.0f,\"prazo_us\":%u,\"perdas\":%u}%s\n",
                    c->name, c->priority, c->period_ms, c->cost_us, s->releases, s->max_resp_us, r->rta[p].R_us, SIL_DEADLINE_US(p), s->missed,
                    p + 1 < SIL_PROC_COUNT ? "," : "");
        }
        fprintf(f, "  ],\n  \"verificacoes\": [\n");
        for (int i = 0; i < r->n_checks; i++)
            fprintf(f, "    {\"nome\":\"%s\",\"ok\":%s,\"detalhe\":\"%s\"}%s\n", r->checks[i].name, r->checks[i].ok ? "true" : "false",
                    r->checks[i].detail, i + 1 < r->n_checks ? "," : "");
        fprintf(f, "  ]\n}\n");
        fclose(f);
    }
}

void ICM_SilFree(ICM_SilRun_t *r) {
    SIL_FreeResult(&r->res);
    free(r->s_speed); free(r->s_rpm); free(r->s_fuel); free(r->s_temp); free(r->s_flags);
    r->s_speed = r->s_rpm = r->s_fuel = r->s_temp = NULL; r->s_flags = NULL;
}
