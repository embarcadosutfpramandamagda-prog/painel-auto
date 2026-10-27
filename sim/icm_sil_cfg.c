/* GERADO por tools/oil2sil.py a partir do oil/icm.oil e sim/wcet.csv - não editar à mão */
#include "osek_sil.h"

extern void ISR2_CAN_function(void);
extern void Task_CAN_RX_function(void);
extern void Task_Acquisition_function(void);
extern void Task_Processing_function(void);
extern void Task_Display_function(void);
extern void Task_Diagnostics_function(void);
extern void Task_Logging_function(void);

const int SIL_RESOURCE_CEILING = 10;

const SIL_ProcCfg_t SIL_PROCS[SIL_PROC_COUNT] = {
    /* nome, prioridade, isr, estendida, autostart, usa recurso, período ms, offset ms, custo us, recurso us, corpo */
    { "ISR2_CAN", 20, true, false, false, false, 0, 0, 25, 0, ISR2_CAN_function },
    { "Task_CAN_RX", 10, false, true, true, true, 0, 0, 90, 30, Task_CAN_RX_function },
    { "Task_Acquisition", 8, false, false, false, true, 10, 10, 180, 40, Task_Acquisition_function },
    { "Task_Processing", 6, false, false, false, true, 20, 20, 140, 90, Task_Processing_function },
    { "Task_Display", 4, false, false, false, true, 50, 50, 1200, 60, Task_Display_function },
    { "Task_Diagnostics", 3, false, false, false, true, 100, 100, 220, 160, Task_Diagnostics_function },
    { "Task_Logging", 1, false, false, false, true, 1000, 1000, 450, 60, Task_Logging_function },
};

const unsigned SIL_DEADLINES_US[SIL_PROC_COUNT] = {
    1000u /* ISR2_CAN */, 2000u /* Task_CAN_RX */, 10000u /* Task_Acquisition */, 20000u /* Task_Processing */, 50000u /* Task_Display */, 100000u /* Task_Diagnostics */, 1000000u /* Task_Logging */
};
