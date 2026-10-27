/* GERADO por tools/oil2sil.py a partir do oil/icm.oil e sim/wcet.csv - não editar à mão */
#ifndef OSEK_SIL_CFG_H
#define OSEK_SIL_CFG_H

#define SIL_PROC_COUNT 7
#define ISR2_CAN 0
#define Task_CAN_RX 1
#define Task_Acquisition 2
#define Task_Processing 3
#define Task_Display 4
#define Task_Diagnostics 5
#define Task_Logging 6
#define Event_CAN_RX (1u << 0)
#define ICM_Resource 0
extern const unsigned SIL_DEADLINES_US[SIL_PROC_COUNT];
#define SIL_DEADLINE_US(p) (SIL_DEADLINES_US[p])

#endif
