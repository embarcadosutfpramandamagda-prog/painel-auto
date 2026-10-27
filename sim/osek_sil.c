/*
 * osek_sil.c - o escalonador OSEK simulado (ver osek_sil.h).
 *
 * Laço principal: pra cada ms do SystemCounter
 *   1. lado do hardware (vehicle_sim): pode pedir a interrupção do CAN;
 *   2. alarmes vencidos ativam as tarefas periódicas;
 *   3. a CPU é simulada em microssegundos até o próximo ms: sempre roda quem
 *      tem a maior prioridade efetiva (prioridade da tarefa, ou o teto do
 *      recurso enquanto ela está dentro dele; ISR acima de tudo).
 */
#include "osek_sil.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    SIL_State_t state;
    uint32_t cost, cs, pre;      /* custo total do job, parte no recurso, parte antes do recurso */
    uint32_t remaining;
    bool body_pending;           /* o corpo ainda não rodou neste job */
    bool will_wait;              /* o corpo terminou num WaitEvent */
    bool terminated;
    bool irq_pending;            /* ISR: chegou outra interrupção enquanto esta rodava */
    EventMaskType events, wait_mask;
    uint32_t release_us, start_us, blocked_us;
    uint16_t preemptions;
    bool started;
    int res_depth;               /* GetResource aninhado dentro do corpo */
} Proc_t;

static Proc_t P[SIL_PROC_COUNT];
static int g_running = -1;       /* quem está com a CPU */
static int g_current = -1;       /* de quem é o corpo que está executando agora */
static uint32_t g_now_us = 0;
static const SIL_Config_t *g_cfg;
static SIL_Result_t *g_res;
static uint64_t g_hash;

uint32_t SIL_NowUs(void) { return g_now_us; }

const char *SIL_StateName(int s) {
    static const char *n[] = { "SUSPENDED", "READY", "RUNNING", "WAITING" };
    return (s >= 0 && s < 4) ? n[s] : "?";
}

static void hash_u32(uint32_t v) {
    for (int i = 0; i < 4; i++) { g_hash ^= (v >> (8 * i)) & 0xFFu; g_hash *= 1099511628211ull; }
}

static void set_state(int p, SIL_State_t s) {
    if (P[p].state == s) return;
    P[p].state = s;
    hash_u32(g_now_us); hash_u32((uint32_t)p); hash_u32((uint32_t)s);
    if (!g_res || !g_cfg->record_trace || g_now_us > g_cfg->trace_window_ms * 1000u) return;
    if (g_res->trace_len == g_res->trace_cap) {
        g_res->trace_cap = g_res->trace_cap ? g_res->trace_cap * 2u : 4096u;
        g_res->trace = (SIL_TraceEvent_t *)realloc(g_res->trace, g_res->trace_cap * sizeof(SIL_TraceEvent_t));
    }
    SIL_TraceEvent_t *e = &g_res->trace[g_res->trace_len++];
    e->t_us = g_now_us; e->proc = (uint8_t)p; e->state = (uint8_t)s;
}

/* começa um job novo (ativação, SetEvent ou interrupção) */
static void release_job(int p) {
    const SIL_ProcCfg_t *c = &SIL_PROCS[p];
    Proc_t *x = &P[p];
    double k = g_cfg->cost_scale > 0.0 ? g_cfg->cost_scale : 1.0;
    x->cost = (uint32_t)(c->cost_us * k + 0.5);
    x->cs = c->uses_resource ? (uint32_t)(c->cs_us * k + 0.5) : 0u;
    if (x->cs > x->cost) x->cs = x->cost;
    x->pre = (x->cost - x->cs) / 2u;
    x->remaining = x->cost;
    x->body_pending = true;
    x->will_wait = false;
    x->terminated = false;
    x->release_us = g_now_us;
    x->blocked_us = 0;
    x->preemptions = 0;
    x->started = false;
    SIL_Stats_t *st = &g_res->stats[p];
    if (st->releases > 0) {
        uint32_t iv = x->release_us - st->last_release_us;
        if (st->min_period_us == 0 || iv < st->min_period_us) st->min_period_us = iv;
        if (iv > st->max_period_us) st->max_period_us = iv;
    }
    st->releases++;
    st->last_release_us = x->release_us;
    set_state(p, SIL_READY);
}

static bool active(int p) { return P[p].state == SIL_READY || P[p].state == SIL_RUNNING; }

StatusType SIL_ActivateTask(TaskType t) {
    if (t < 0 || t >= SIL_PROC_COUNT || SIL_PROCS[t].is_isr) return E_OS_ACCESS;
    if (P[t].state != SIL_SUSPENDED) {          /* ACTIVATION = 1 */
        g_res->stats[t].lost_activations++;
        g_res->stats[t].missed++;
        return E_OS_LIMIT;
    }
    release_job(t);
    return E_OK;
}

StatusType SIL_SetEvent(TaskType t, EventMaskType m) {
    if (t < 0 || t >= SIL_PROC_COUNT || !SIL_PROCS[t].extended) return E_OS_ACCESS;
    if (P[t].state == SIL_SUSPENDED) return E_OS_STATE;
    P[t].events |= m;
    if (P[t].state == SIL_WAITING && (P[t].events & P[t].wait_mask)) release_job(t);
    else if (active(t) && P[t].will_wait && (P[t].events & P[t].wait_mask)) P[t].will_wait = false; /* ainda rodando: não vai dormir */
    return E_OK;
}

StatusType SIL_ClearEvent(EventMaskType m) {
    if (g_current < 0) return E_OS_ACCESS;
    P[g_current].events &= ~m;
    return E_OK;
}

bool SIL_MustWait(EventMaskType m) {
    if (g_current < 0) return false;
    if (P[g_current].events & m) return false;
    P[g_current].wait_mask = m;
    P[g_current].will_wait = true;
    return true;
}

StatusType SIL_GetResource(ResourceType r) {
    (void)r;
    if (g_current < 0) return E_OK;              /* fora do sistema (inicialização) */
    if (SIL_PROCS[g_current].is_isr || !SIL_PROCS[g_current].uses_resource) { g_res->api_errors++; return E_OS_ACCESS; }
    P[g_current].res_depth++;
    return E_OK;
}

StatusType SIL_ReleaseResource(ResourceType r) {
    (void)r;
    if (g_current < 0) return E_OK;
    if (P[g_current].res_depth <= 0) { g_res->api_errors++; return E_OS_NOFUNC; }
    P[g_current].res_depth--;
    return E_OK;
}

void SIL_TerminateTask(void) {
    if (g_current >= 0) P[g_current].terminated = true;
}

/* está dentro do recurso agora? (pela parte do custo já gasta) */
static bool in_cs(int p) {
    const Proc_t *x = &P[p];
    if (x->cs == 0 || !x->started) return false;
    uint32_t done = x->cost - x->remaining;
    return done >= x->pre && done < x->pre + x->cs;
}

static int eff_prio(int p) {
    const SIL_ProcCfg_t *c = &SIL_PROCS[p];
    if (c->is_isr) return 1000 + c->priority;
    if (in_cs(p) && SIL_RESOURCE_CEILING > c->priority) return SIL_RESOURCE_CEILING;
    return c->priority;
}

static int pick(void) {
    int best = -1;
    for (int p = 0; p < SIL_PROC_COUNT; p++) {
        if (!active(p)) continue;
        if (best < 0) { best = p; continue; }
        int a = eff_prio(p), b = eff_prio(best);
        if (a > b) best = p;
        else if (a == b) {
            /* mesma prioridade: quem já está rodando continua; senão, quem chegou antes */
            if (p == g_running) best = p;
            else if (best != g_running && P[p].release_us < P[best].release_us) best = p;
        }
    }
    return best;
}

static void push_job(int p) {
    if (g_res->jobs_len == g_res->jobs_cap) {
        g_res->jobs_cap = g_res->jobs_cap ? g_res->jobs_cap * 2u : 8192u;
        g_res->jobs = (SIL_Job_t *)realloc(g_res->jobs, g_res->jobs_cap * sizeof(SIL_Job_t));
    }
    SIL_Job_t *j = &g_res->jobs[g_res->jobs_len++];
    j->proc = (uint8_t)p; j->release_us = P[p].release_us; j->start_us = P[p].start_us;
    j->finish_us = g_now_us; j->blocked_us = P[p].blocked_us; j->preemptions = P[p].preemptions;
}

static void finish_job(int p) {
    const SIL_ProcCfg_t *c = &SIL_PROCS[p];
    SIL_Stats_t *st = &g_res->stats[p];
    uint32_t resp = g_now_us - P[p].release_us;
    st->jobs++;
    st->sum_resp_us += resp;
    if (st->min_resp_us == 0 || resp < st->min_resp_us) st->min_resp_us = resp;
    if (resp > st->max_resp_us) st->max_resp_us = resp;
    if (P[p].blocked_us > st->max_blocked_us) st->max_blocked_us = P[p].blocked_us;
    uint32_t deadline = SIL_DEADLINE_US(p);
    if (resp > deadline) st->missed++;
    push_job(p);
    if (g_running == p) g_running = -1;

    if (c->is_isr) {
        if (P[p].irq_pending) { P[p].irq_pending = false; release_job(p); }
        else set_state(p, SIL_SUSPENDED);
    } else if (c->extended && P[p].will_wait && !P[p].terminated) {
        if (P[p].events & P[p].wait_mask) release_job(p);   /* evento chegou enquanto rodava */
        else set_state(p, SIL_WAITING);
    } else {
        set_state(p, SIL_SUSPENDED);
    }
}

static void run_body(int p) {
    int prev = g_current;
    g_current = p;
    P[p].res_depth = 0;
    SIL_PROCS[p].body();
    if (P[p].res_depth != 0) { g_res->api_errors++; P[p].res_depth = 0; }   /* saiu com o recurso preso */
    g_current = prev;
}

static void cpu_until(uint32_t end_us) {
    while (g_now_us < end_us) {
        int p = pick();
        if (p < 0) { g_res->idle_us += end_us - g_now_us; g_now_us = end_us; return; }
        if (g_running != p) {
            if (g_running >= 0 && P[g_running].state == SIL_RUNNING) {
                P[g_running].preemptions++;
                g_res->stats[g_running].preemptions++;
                set_state(g_running, SIL_READY);
            }
            g_running = p;
            set_state(p, SIL_RUNNING);
            if (!P[p].started) {
                P[p].started = true;
                P[p].start_us = g_now_us;
                uint32_t jit = g_now_us - P[p].release_us;
                if (jit > g_res->stats[p].max_start_jitter_us) g_res->stats[p].max_start_jitter_us = jit;
            }
        }
        if (P[p].body_pending) {
            P[p].body_pending = false;
            run_body(p);
            continue;                       /* o corpo pode ter acordado alguém: escolhe de novo */
        }
        /* roda até a próxima fronteira (entrar/sair do recurso, fim do job ou fim do ms) */
        Proc_t *x = &P[p];
        uint32_t done = x->cost - x->remaining, step;
        if (x->cs && done < x->pre) step = x->pre - done;
        else if (x->cs && done < x->pre + x->cs) step = x->pre + x->cs - done;
        else step = x->remaining;
        if (step == 0) step = x->remaining;
        if (step > end_us - g_now_us) step = end_us - g_now_us;

        /* verificações de recurso no intervalo */
        int holders = 0, holder = -1;
        for (int q = 0; q < SIL_PROC_COUNT; q++) if ((active(q)) && in_cs(q)) { holders++; holder = q; }
        if ((uint32_t)holders > g_res->max_resource_holders) g_res->max_resource_holders = (uint32_t)holders;
        if (holder >= 0 && holder != p && !SIL_PROCS[p].is_isr && SIL_PROCS[p].priority <= SIL_RESOURCE_CEILING)
            g_res->resource_violations++;
        if (in_cs(p)) {
            for (int q = 0; q < SIL_PROC_COUNT; q++)
                if (q != p && P[q].state == SIL_READY && !SIL_PROCS[q].is_isr &&
                    SIL_PROCS[q].priority > SIL_PROCS[p].priority) P[q].blocked_us += step;
        }

        g_now_us += step;
        x->remaining -= step;
        g_res->stats[p].busy_us += step;
        if (x->remaining == 0) finish_job(p);
    }
}

void SIL_Run(const SIL_Config_t *cfg, SIL_Result_t *res) {
    memset(res, 0, sizeof(*res));
    memset(P, 0, sizeof(P));
    g_cfg = cfg; g_res = res;
    g_running = -1; g_current = -1; g_now_us = 0;
    g_hash = 1469598103934665603ull;

    for (int p = 0; p < SIL_PROC_COUNT; p++) {
        P[p].state = SIL_SUSPENDED;
        if (SIL_PROCS[p].autostart) release_job(p);
    }
    for (uint32_t ms = 0; ms < cfg->duration_ms; ms++) {
        g_now_us = ms * 1000u;
        if (cfg->on_tick) cfg->on_tick(ms);
        if (cfg->hw_irq && cfg->hw_irq(ms)) {
            for (int p = 0; p < SIL_PROC_COUNT; p++) {
                if (!SIL_PROCS[p].is_isr) continue;
                if (active(p)) P[p].irq_pending = true; else release_job(p);
            }
        }
        /* alarmes do SystemCounter */
        for (int p = 0; p < SIL_PROC_COUNT; p++) {
            const SIL_ProcCfg_t *c = &SIL_PROCS[p];
            if (c->period_ms == 0 || ms < c->offset_ms) continue;
            if ((ms - c->offset_ms) % c->period_ms == 0) SIL_ActivateTask(p);
        }
        cpu_until((ms + 1u) * 1000u);
    }
    res->total_us = (uint64_t)cfg->duration_ms * 1000u;
    res->trace_hash = g_hash;
}

void SIL_FreeResult(SIL_Result_t *res) {
    free(res->trace); free(res->jobs);
    res->trace = NULL; res->jobs = NULL;
}
