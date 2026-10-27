/*
 * tasks.c - a ISR e as tarefas declaradas no oil/icm.oil.
 *
 * O mesmo arquivo compila em três lugares:
 *   - TRAMPOLINE_RTOS: no Trampoline (placa ou alvo posix), com o código gerado pelo goil;
 *   - ICM_SIL:         no núcleo OSEK simulado (sim/osek_sil.c), pros testes de tempo;
 *   - nenhum dos dois: não compila (as tarefas só fazem sentido com um sistema embaixo).
 *
 * Caminho de cada dado, igual ao slide do projeto:
 *   ISR2_CAN (Receive) -> Task_CAN_RX (Validate + Scale) -> Task_Processing (Filter)
 *   -> Task_Display (Display); Task_Diagnostics vigia timeout e faixa; Task_Logging guarda.
 *
 * O "hardware" (controlador CAN, ADC, chaves) aqui é o vehicle_sim.c. Na placa,
 * as chamadas VSim_* viram leitura de registrador do driver.
 */
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include "icm_data.h"
#include "icm_display.h"
#include "icm_tasks.h"
#include "vehicle_sim.h"

#if defined(TRAMPOLINE_RTOS)
#include "tpl_os.h"
DeclareTask(Task_CAN_RX);
DeclareEvent(Event_CAN_RX);
DeclareResource(ICM_Resource);
#elif defined(ICM_SIL)
#include "osek_sil.h"
#else
#error "tasks.c precisa do Trampoline (TRAMPOLINE_RTOS) ou do simulador (ICM_SIL)"
#endif

/* --- relógio da aplicação --- */
static volatile uint32_t g_now_ms = 0;
uint32_t ICM_NowMs(void) { return g_now_ms; }
void ICM_SetNowMs(uint32_t ms) { g_now_ms = ms; }

/* --- fila de software: a ISR coloca os frames aqui e a Task_CAN_RX tira --- */
#define RX_FIFO_SIZE 16u
static CAN_Frame_t g_rx_can_fifo[RX_FIFO_SIZE];
static volatile uint8_t g_rx_head = 0;
static volatile uint8_t g_rx_tail = 0;
static volatile uint32_t g_rx_overflow = 0;

/* --- saída do display e contadores, pra simulação e testes --- */
static ICM_DisplayFrame_t g_frame;
static bool g_have_frame = false;
static ICM_TaskCounters_t g_cnt;
static int g_verbose = 0;

void ICM_TasksInit(int verbose) {
    g_rx_head = g_rx_tail = 0;
    g_rx_overflow = 0;
    memset(&g_frame, 0, sizeof(g_frame));
    memset(&g_cnt, 0, sizeof(g_cnt));
    g_have_frame = false;
    g_verbose = verbose;
    g_now_ms = 0;
    ICM_Init();
}

const ICM_DisplayFrame_t *ICM_LastFrame(void) { return g_have_frame ? &g_frame : NULL; }
const ICM_TaskCounters_t *ICM_Counters(void) { return &g_cnt; }

/* ISR de categoria 2 porque chama serviço do sistema (SetEvent).
 * Só tira os frames do controlador e acorda a tarefa: nada de decodificar aqui. */
ISR(ISR2_CAN) {
    CAN_Frame_t f;
    g_cnt.isr_can++;
    while (VSim_CanRead(&f)) {
        uint8_t next = (uint8_t)((g_rx_head + 1u) % RX_FIFO_SIZE);
        if (next == g_rx_tail) { g_rx_overflow++; continue; }   /* fila cheia: perde o frame */
        g_rx_can_fifo[g_rx_head] = f;
        g_rx_head = next;
    }
    SetEvent(Task_CAN_RX, Event_CAN_RX);
}

/* estendida: fica no WaitEvent até a ISR avisar. Validate + Scale ficam no ICM_DecodeFrame. */
TASK(Task_CAN_RX) {
    while (1) {
        WaitEvent(Event_CAN_RX);
        ClearEvent(Event_CAN_RX);
        g_cnt.can_rx++;
        /* pode ter chegado mais de um frame desde a última vez (M1 e M2 juntos no t = 1 s) */
        while (g_rx_head != g_rx_tail) {
            CAN_Frame_t frame = g_rx_can_fifo[g_rx_tail];
            g_rx_tail = (uint8_t)((g_rx_tail + 1u) % RX_FIFO_SIZE);
            ICM_DecodeFrame(&frame);
            g_cnt.frames_decoded++;
        }
    }
    TerminateTask();   /* nunca chega aqui */
}

/* 10 ms - ADC (combustível, temperatura) e GPIO (setas, cinto) */
TASK(Task_Acquisition) {
    ICM_SensorInputs_t in;
    g_cnt.acquisition++;
    VSim_ReadSensors(&in);
    ICM_AcquireSensors(&in, g_now_ms);
    TerminateTask();
}

/* 20 ms - filtros */
TASK(Task_Processing) {
    g_cnt.processing++;
    ICM_FilterAndScale();
    TerminateTask();
}

/* 50 ms - monta o quadro do painel a partir de uma cópia do ICM_Data (20 quadros/s) */
TASK(Task_Display) {
    ICM_Data_t copy;
    ICM_DisplayFrame_t next;
    g_cnt.display++;
    ICM_GetDataCopy(&copy);
    ICM_BuildDisplayFrame(&copy, g_have_frame ? &g_frame : NULL, &next, g_now_ms);
    g_frame = next;
    g_have_frame = true;
    if (g_verbose && (g_frame.frame_no % 10u) == 0u) {   /* imprime 2 vezes por segundo */
        char line[200];
        ICM_FormatDisplayLine(&g_frame, line, sizeof(line));
        puts(line);
    }
    TerminateTask();
}

/* 100 ms - timeouts e luzes de aviso */
TASK(Task_Diagnostics) {
    g_cnt.diagnostics++;
    ICM_EvaluateDiagnostics(g_now_ms);
    TerminateTask();
}

/* 1000 ms - odômetro, consumo e uma linha de telemetria */
TASK(Task_Logging) {
    ICM_Data_t d;
    g_cnt.logging++;
    ICM_UpdateLogging(1.0f);
    if (g_verbose > 1) {
        ICM_GetDataCopy(&d);
        printf("LOG t=%u speed=%.1f rpm=%.0f fuel=%.1f temp=%.1f flags=0x%03x dtc=%s\n",
               (unsigned)g_now_ms, (double)d.vehicle_speed_kmh, (double)d.engine_rpm,
               (double)d.fuel_level_percent, (double)d.coolant_temp_celsius,
               (unsigned)d.warning_flags, d.active_dtc);
    }
    TerminateTask();
}

#if defined(TRAMPOLINE_RTOS) && defined(ICM_POSIX_DEMO)
/*
 * Só no alvo posix do Trampoline (oil/icm_posix.oil): faz o papel do resto do
 * carro. A cada tick (10 ms no posix) anda a simulação 10 ms; se chegou frame no
 * controlador, gera a "interrupção" mandando SIGPIPE pro próprio processo, que o
 * Trampoline posix entrega pra ISR2_CAN (SOURCE = SIGPIPE no .oil).
 */
#include <signal.h>
#include <unistd.h>

TASK(Task_VehicleSim) {
    bool irq = false;
    for (int i = 0; i < 10; i++) {
        g_now_ms++;
        if (VSim_Step1ms(g_now_ms)) irq = true;
    }
    if (irq) kill(getpid(), SIGPIPE);
    TerminateTask();
}

int main(void) {
    unsigned n;
    setvbuf(stdout, NULL, _IOLBF, 0);   /* uma linha por vez, mesmo com a saída num pipe/arquivo */
    ICM_TasksInit(1);
    VSim_Init();
    VSim_SetScenario(VSim_DemoScenario(&n), n);
    puts("ICM no Trampoline (posix). Ctrl+C pra sair.");
    StartOS(OSDEFAULTAPPMODE);
    return 0;
}
#endif
