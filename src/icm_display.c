/*
 * icm_display.c - Task_Display: transforma o ICM_Data no quadro do painel.
 *
 * Mesma ordem de mensagens e mesmas regras das luzes do painel do site
 * (web/js/jogo.js, currentMessage e lampStates).
 */
#include "icm_display.h"
#include <stdio.h>
#include <string.h>

static float slew(float from, float to, float step) {
    float d = to - from;
    if (d > step) d = step;
    if (d < -step) d = -step;
    return from + d;
}

static void set_msg(ICM_DisplayFrame_t *f, const char *txt, bool warn) {
    strncpy(f->message, txt, sizeof(f->message) - 1);
    f->message[sizeof(f->message) - 1] = '\0';
    f->message_warn = warn;
}

/* qual mensagem aparece: a primeira da lista que valer (falha de comunicação primeiro) */
static void choose_message(const ICM_Data_t *d, ICM_DisplayFrame_t *f, bool bulb) {
    uint16_t fl = d->warning_flags;
    char tmp[28];
    if (bulb)                           { set_msg(f, "TESTE DE LUZES", false); return; }
    if (fl & FLAG_CAN_M1_TIMEOUT)       { set_msg(f, "FALHA CAN U0100", true); return; }
    if (fl & FLAG_SIGNAL_OOR)           { set_msg(f, "SINAL INVALIDO U0401", true); return; }
    if (fl & FLAG_CAN_M2_TIMEOUT)       { set_msg(f, "FALHA CAN U0101", true); return; }
    if (fl & FLAG_TEMP_SENSOR)          { set_msg(f, "SENS.TEMP P0115", true); return; }
    if (fl & FLAG_COOLANT_HOT) {
        snprintf(tmp, sizeof(tmp), "MOTOR QUENTE! %dC", (int)(d->coolant_temp_celsius + 0.5f));
        set_msg(f, tmp, true); return;
    }
    if (fl & FLAG_FUEL_SENSOR)          { set_msg(f, "SENS.COMB P0460", true); return; }
    if (fl & FLAG_LOW_FUEL) {
        snprintf(tmp, sizeof(tmp), "RESERVA %d%%", (int)(d->fuel_level_percent + 0.5f));
        set_msg(f, tmp, true); return;
    }
    if (fl & FLAG_OIL_PRESS_LOW)        { set_msg(f, "MOTOR DESLIGADO", true); return; }
    if (fl & FLAG_SEATBELT_WARN)        { set_msg(f, "APERTE O CINTO", true); return; }
    if (d->engine_rpm >= 6500.0f)       { set_msg(f, "GIRO ALTO! TROQUE MARCHA", true); return; }
    if (fl & FLAG_HANDBRAKE_ON)         { set_msg(f, "FREIO DE MAO", false); return; }
    snprintf(tmp, sizeof(tmp), "TRIP %.1f KM %dC", (double)d->trip_a_km, (int)(d->coolant_temp_celsius + 0.5f));
    set_msg(f, tmp, false);
}

void ICM_BuildDisplayFrame(const ICM_Data_t *d, const ICM_DisplayFrame_t *prev,
                           ICM_DisplayFrame_t *out, uint32_t now_ms) {
    ICM_DisplayFrame_t f;
    memset(&f, 0, sizeof(f));
    uint16_t fl = d->warning_flags;
    bool bulb = now_ms < ICM_BULB_CHECK_MS;

    f.frame_no = prev ? prev->frame_no + 1 : 1;
    f.time_ms = now_ms;

    /* ponteiros: no teste de lâmpadas varrem a escala toda; depois seguem o dado com passo limitado */
    float last_s = prev ? prev->needle_speed_kmh : 0.0f;
    float last_r = prev ? prev->needle_rpm : 0.0f;
    float target_s = d->vehicle_speed_kmh, target_r = d->engine_rpm;
    if (bulb) { target_s = 250.0f; target_r = 8000.0f; }
    f.needle_speed_kmh = slew(last_s, target_s, ICM_NEEDLE_STEP_KMH);
    f.needle_rpm = slew(last_r, target_r, ICM_NEEDLE_STEP_RPM);

    f.fuel_percent = d->fuel_sensor_ok ? d->fuel_level_percent : -1.0f;
    f.coolant_celsius = d->temp_sensor_ok ? d->coolant_temp_celsius : -1.0f;

    bool blink = ICM_TurnLampOn(now_ms);
    bool left = d->turn_signal == TURN_LEFT || d->turn_signal == TURN_HAZARD;
    bool right = d->turn_signal == TURN_RIGHT || d->turn_signal == TURN_HAZARD;
    f.lamp_turn_left  = bulb || (left && blink);
    f.lamp_turn_right = bulb || (right && blink);
    f.lamp_mil     = bulb || (fl & FLAG_MIL_CHECK_ENG);
    f.lamp_can     = bulb || (fl & (FLAG_CAN_M1_TIMEOUT | FLAG_CAN_M2_TIMEOUT));
    f.lamp_temp    = bulb || (fl & (FLAG_COOLANT_HOT | FLAG_TEMP_SENSOR));
    f.lamp_fuel    = bulb || (fl & FLAG_LOW_FUEL) || ((fl & FLAG_FUEL_SENSOR) && blink);
    f.lamp_brake   = bulb || (fl & FLAG_HANDBRAKE_ON);
    f.lamp_belt    = bulb || ((fl & FLAG_SEATBELT_WARN) && blink);
    f.lamp_oil     = bulb || (fl & FLAG_OIL_PRESS_LOW);
    f.lamp_battery = bulb || (fl & FLAG_BATTERY_FAULT);

    if (d->gear >= 1) snprintf(f.gear, sizeof(f.gear), "D%d", (int)(d->gear > 9 ? 9 : d->gear));
    else if (d->gear < 0) strcpy(f.gear, "R");
    else strcpy(f.gear, d->handbrake_active ? "P" : "N");

    if (bulb) strcpy(f.speed_text, "888");
    else if (fl & FLAG_CAN_M2_TIMEOUT) strcpy(f.speed_text, "---");
    else snprintf(f.speed_text, sizeof(f.speed_text), "%d", (int)(d->vehicle_speed_kmh + 0.5f));

    choose_message(d, &f, bulb);

    f.odometer_km = d->odometer_km;
    f.trip_km = d->trip_a_km;
    f.m1_age_ms = d->last_m1_time_ms ? now_ms - d->last_m1_time_ms : now_ms;
    f.m2_age_ms = d->last_m2_time_ms ? now_ms - d->last_m2_time_ms : now_ms;
    *out = f;
}

void ICM_FormatDisplayLine(const ICM_DisplayFrame_t *f, char *buf, unsigned size) {
    snprintf(buf, size,
        "%6.2fs | %3s km/h  %4.0f rpm  %-3s | comb %5.1f%%  temp %5.1fC | %s%s%s%s%s%s%s%s%s%s| ODO %07.1f | %s",
        f->time_ms / 1000.0, f->speed_text, (double)f->needle_rpm, f->gear,
        (double)f->fuel_percent, (double)f->coolant_celsius,
        f->lamp_turn_left ? "<" : ".", f->lamp_turn_right ? ">" : ".",
        f->lamp_mil ? "M" : ".", f->lamp_can ? "C" : ".", f->lamp_temp ? "T" : ".",
        f->lamp_fuel ? "F" : ".", f->lamp_brake ? "B" : ".", f->lamp_belt ? "S" : ".",
        f->lamp_oil ? "O" : ".", f->lamp_battery ? "A" : ".",
        f->odometer_km, f->message);
}
