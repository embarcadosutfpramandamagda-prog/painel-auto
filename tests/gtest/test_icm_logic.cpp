/*
 * test_icm_logic.cpp - Google Test da lógica do ICM (src/icm_data.c e src/icm_display.c).
 *
 * Cada teste diz qual requisito cobre (docs/REQUISITOS_ICM.md). Estratégias do
 * slide de Google Test: valores-limite, partição de equivalência, entradas
 * inválidas, robustez e regressão.
 */
#include <gtest/gtest.h>
#include <pthread.h>
#include <atomic>
#include <cstring>

extern "C" {
#include "icm_data.h"
#include "icm_display.h"
}

namespace {

/* monta um M1 com o rpm já na resolução de 0,25 */
CAN_Msg_M1_t m1(float rpm, uint8_t state = 2) {
    CAN_Msg_M1_t m; std::memset(&m, 0, sizeof(m));
    uint16_t raw = (uint16_t)(rpm / 0.25f + 0.5f);
    m.rpm_high = (uint8_t)(raw >> 8); m.rpm_low = (uint8_t)(raw & 0xFF);
    m.engine_state = state;
    return m;
}
CAN_Msg_M1_t m1_raw(uint16_t raw) {
    CAN_Msg_M1_t m; std::memset(&m, 0, sizeof(m));
    m.rpm_high = (uint8_t)(raw >> 8); m.rpm_low = (uint8_t)(raw & 0xFF); m.engine_state = 2;
    return m;
}
CAN_Msg_M2_t m2(float kmh, int8_t gear = 3, bool hand = false) {
    CAN_Msg_M2_t m; std::memset(&m, 0, sizeof(m));
    uint16_t raw = (uint16_t)(kmh / 0.05f + 0.5f);
    m.speed_high = (uint8_t)(raw >> 8); m.speed_low = (uint8_t)(raw & 0xFF);
    m.current_gear = gear; m.handbrake = hand ? 1 : 0;
    return m;
}
CAN_Msg_M2_t m2_raw(uint16_t raw) {
    CAN_Msg_M2_t m; std::memset(&m, 0, sizeof(m));
    m.speed_high = (uint8_t)(raw >> 8); m.speed_low = (uint8_t)(raw & 0xFF);
    return m;
}

void send1(CAN_Msg_M1_t m, uint32_t ts) { ICM_ProcessCAN_M1(&m, ts); }
void send2(CAN_Msg_M2_t m, uint32_t ts) { ICM_ProcessCAN_M2(&m, ts); }
void acquire(ICM_SensorInputs_t in, uint32_t ts) { ICM_AcquireSensors(&in, ts); }

class IcmTest : public ::testing::Test {
protected:
    void SetUp() override { ICM_Init(); }
    ICM_Data_t data() { ICM_Data_t d; ICM_GetDataCopy(&d); return d; }
    void settle(int n = 400) { for (int i = 0; i < n; i++) ICM_FilterAndScale(); }
    ICM_SensorInputs_t sensors(float fuel_v = 2.5f, float temp_v = 2.5f) {
        ICM_SensorInputs_t in; std::memset(&in, 0, sizeof(in));
        in.fuel_volts = fuel_v; in.temp_volts = temp_v; in.seatbelt_buckled = true; in.turn = TURN_NONE;
        return in;
    }
};

}  // namespace

/* ---------- RF-01 / RF-02: decodificação CAN (Receive -> Scale) ---------- */

TEST_F(IcmTest, RF01_M1DecodesRpmWithQuarterResolution) {
    CAN_Msg_M1_t m = m1(3000.0f);
    EXPECT_EQ(m.rpm_high, 0x2E);
    EXPECT_EQ(m.rpm_low, 0xE0);
    ICM_ProcessCAN_M1(&m, 100);
    settle();
    EXPECT_NEAR(data().engine_rpm, 3000.0f, 0.5f);
    EXPECT_EQ(data().last_m1_time_ms, 100u);
    EXPECT_EQ(data().frames_m1, 1u);
}

TEST_F(IcmTest, RF02_M2DecodesSpeedGearAndHandbrake) {
    CAN_Msg_M2_t m = m2(120.0f, 4, true);
    ICM_ProcessCAN_M2(&m, 200);
    settle();
    ICM_Data_t d = data();
    EXPECT_NEAR(d.vehicle_speed_kmh, 120.0f, 0.1f);
    EXPECT_EQ(d.gear, 4);
    EXPECT_TRUE(d.handbrake_active);
    EXPECT_EQ(d.last_m2_time_ms, 200u);
}

TEST_F(IcmTest, RF02_ReverseGearIsSignedByte) {
    CAN_Frame_t f; std::memset(&f, 0, sizeof(f));
    f.id = CAN_ID_M2_VEHICLE; f.dlc = 8; f.timestamp_ms = 50; f.data[2] = 0xFF;   /* -1 = ré */
    ICM_DecodeFrame(&f);
    EXPECT_EQ(data().gear, -1);
}

TEST_F(IcmTest, DecodeFrameIgnoresUnknownId) {
    CAN_Frame_t f; std::memset(&f, 0, sizeof(f));
    f.id = 0x7DF; f.data[0] = 0xFF; f.data[1] = 0xFF; f.timestamp_ms = 10;
    ICM_DecodeFrame(&f);
    EXPECT_EQ(data().frames_m1, 0u);
    EXPECT_EQ(data().frames_m2, 0u);
}

/* ---------- valores-limite das escalas (0 a 8000 rpm, 0 a 250 km/h) ---------- */

TEST_F(IcmTest, Boundary_RpmZeroAndFullScale) {
    send1(m1(0.0f), 10); settle();
    EXPECT_NEAR(data().engine_rpm, 0.0f, 0.01f);
    send1(m1(8000.0f), 20); settle();
    EXPECT_NEAR(data().engine_rpm, 8000.0f, 0.5f);
}

TEST_F(IcmTest, Boundary_SpeedZeroAndFullScale) {
    send2(m2(0.0f), 10); settle();
    EXPECT_NEAR(data().vehicle_speed_kmh, 0.0f, 0.01f);
    send2(m2(250.0f), 20); settle();
    EXPECT_NEAR(data().vehicle_speed_kmh, 250.0f, 0.1f);
}

/* ---------- RS-05: sinal fora da faixa (Validate) ---------- */

TEST_F(IcmTest, RS05_Rpm8500IsAcceptedAndClampedTo8000) {
    send1(m1_raw(34000), 10);           /* 34000 x 0,25 = 8500 rpm: ainda vale */
    settle();
    EXPECT_FALSE(data().signal_out_of_range);
    EXPECT_NEAR(data().engine_rpm, 8000.0f, 0.5f);
}

TEST_F(IcmTest, RS05_RpmAbove8500IsDiscardedKeepsLastValid) {
    send1(m1(3000.0f), 100); settle();
    send1(m1_raw(34001), 600);          /* 8500,25 rpm: lixo */
    settle();
    ICM_EvaluateDiagnostics(650);
    ICM_Data_t d = data();
    EXPECT_NEAR(d.engine_rpm, 3000.0f, 0.5f);
    EXPECT_TRUE(d.warning_flags & FLAG_SIGNAL_OOR);
    EXPECT_TRUE(d.warning_flags & FLAG_MIL_CHECK_ENG);
    EXPECT_STREQ(d.active_dtc, "U0401");
    EXPECT_EQ(d.frames_rejected, 1u);
    EXPECT_EQ(d.last_m1_time_ms, 600u) << "frame chegou: não pode contar como timeout";
}

TEST_F(IcmTest, RS05_SpeedAbove260IsDiscarded) {
    send2(m2(80.0f), 100); settle();
    send2(m2_raw(5200), 1100);          /* 260 km/h: ainda vale (vira 250) */
    settle();
    EXPECT_NEAR(data().vehicle_speed_kmh, 250.0f, 0.1f);
    send2(m2_raw(5201), 2100);          /* 260,05 km/h: descarta */
    settle();
    EXPECT_NEAR(data().vehicle_speed_kmh, 250.0f, 0.1f);
    EXPECT_TRUE(data().signal_out_of_range);
}

TEST_F(IcmTest, RS05_ValidFrameClearsOutOfRange) {
    send1(m1_raw(0xFFFF), 100);
    ICM_EvaluateDiagnostics(150);
    EXPECT_TRUE(data().warning_flags & FLAG_SIGNAL_OOR);
    send1(m1(2000.0f), 600);
    ICM_EvaluateDiagnostics(650);
    EXPECT_FALSE(data().warning_flags & FLAG_SIGNAL_OOR);
    EXPECT_TRUE(data().dtc_history & DTC_U0401) << "o histórico guarda a falha que já passou";
}

/* ---------- RS-01 / RS-02: timeout do CAN e valor seguro ---------- */

TEST_F(IcmTest, RS01_NoTimeoutAtExactly1000ms) {
    send1(m1(3000.0f), 1000); settle();
    ICM_EvaluateDiagnostics(2000);                   /* 1000 ms sem frame: ainda não é > 1000 */
    EXPECT_FALSE(data().warning_flags & FLAG_CAN_M1_TIMEOUT);
}

TEST_F(IcmTest, RS01_TimeoutAfter1000msSetsU0100MilAndSafeRpm) {
    send1(m1(3000.0f), 1000); settle();
    ICM_EvaluateDiagnostics(2001);
    ICM_Data_t d = data();
    EXPECT_TRUE(d.warning_flags & FLAG_CAN_M1_TIMEOUT);
    EXPECT_TRUE(d.warning_flags & FLAG_MIL_CHECK_ENG);
    EXPECT_STREQ(d.active_dtc, "U0100");
    EXPECT_EQ(d.engine_rpm, 0.0f);
    settle();
    EXPECT_EQ(data().engine_rpm, 0.0f) << "o filtro não pode puxar o rpm de volta pro valor velho";
}

TEST_F(IcmTest, RS02_M2TimeoutBoundaryAt2000ms) {
    send2(m2(90.0f), 1000); settle();
    ICM_EvaluateDiagnostics(3000);
    EXPECT_FALSE(data().warning_flags & FLAG_CAN_M2_TIMEOUT);
    ICM_EvaluateDiagnostics(3001);
    ICM_Data_t d = data();
    EXPECT_TRUE(d.warning_flags & FLAG_CAN_M2_TIMEOUT);
    EXPECT_STREQ(d.active_dtc, "U0101");
    EXPECT_EQ(d.vehicle_speed_kmh, 0.0f);
}

TEST_F(IcmTest, RS01_NeverReceivedIsNotTimeout) {
    ICM_EvaluateDiagnostics(10000);
    EXPECT_EQ(data().warning_flags & (FLAG_CAN_M1_TIMEOUT | FLAG_CAN_M2_TIMEOUT), 0);
}

TEST_F(IcmTest, RS01_RecoversWhenFramesComeBack) {
    send1(m1(3000.0f), 1000);
    ICM_EvaluateDiagnostics(2500);
    ASSERT_TRUE(data().warning_flags & FLAG_CAN_M1_TIMEOUT);
    send1(m1(2500.0f), 2600); settle();
    ICM_EvaluateDiagnostics(2700);
    EXPECT_FALSE(data().warning_flags & FLAG_CAN_M1_TIMEOUT);
    EXPECT_NEAR(data().engine_rpm, 2500.0f, 1.0f);
    EXPECT_TRUE(data().dtc_history & DTC_U0100);
}

TEST_F(IcmTest, DtcPriorityCommunicationFirstHistoryKeepsAll) {
    send1(m1(3000.0f), 1000);
    acquire(sensors(4.95f, 2.5f), 1000);   /* boia solta */
    ICM_EvaluateDiagnostics(2500);
    ICM_Data_t d = data();
    EXPECT_STREQ(d.active_dtc, "U0100");
    EXPECT_TRUE(d.dtc_history & DTC_U0100);
    EXPECT_TRUE(d.dtc_history & DTC_P0460);
}

/* ---------- RF-03 / RF-04: sensores (Validate -> Scale) ---------- */

TEST_F(IcmTest, RF03_FuelVoltsScaleLinearly) {
    EXPECT_NEAR(ICM_FuelVoltsToPercent(0.5f), 0.0f, 1e-4);
    EXPECT_NEAR(ICM_FuelVoltsToPercent(2.5f), 50.0f, 1e-4);
    EXPECT_NEAR(ICM_FuelVoltsToPercent(4.5f), 100.0f, 1e-4);
    EXPECT_NEAR(ICM_FuelVoltsToPercent(4.6f), 100.0f, 1e-4) << "satura em 100 %";
}

TEST_F(IcmTest, RF04_TempVoltsScaleLinearly) {
    EXPECT_NEAR(ICM_TempVoltsToCelsius(0.2f), 40.0f, 1e-3);
    EXPECT_NEAR(ICM_TempVoltsToCelsius(2.5f), 80.0f, 1e-3);
    EXPECT_NEAR(ICM_TempVoltsToCelsius(4.8f), 120.0f, 1e-3);
}

TEST_F(IcmTest, RF03_FuelSensorElectricalBoundaries) {
    const struct { float v; bool ok; } cases[] = { {0.29f, false}, {0.30f, true}, {4.70f, true}, {4.71f, false} };
    for (const auto &c : cases) {
        acquire(sensors(c.v, 2.5f), 10);
        ICM_EvaluateDiagnostics(20);
        EXPECT_EQ(data().fuel_sensor_ok, c.ok) << "tensão " << c.v;
        EXPECT_EQ((data().warning_flags & FLAG_FUEL_SENSOR) != 0, !c.ok) << "tensão " << c.v;
    }
}

TEST_F(IcmTest, RF04_TempSensorElectricalBoundaries) {
    const struct { float v; bool ok; } cases[] = { {0.09f, false}, {0.10f, true}, {4.90f, true}, {4.91f, false} };
    for (const auto &c : cases) {
        acquire(sensors(2.5f, c.v), 10);
        ICM_EvaluateDiagnostics(20);
        EXPECT_EQ(data().temp_sensor_ok, c.ok) << "tensão " << c.v;
    }
}

TEST_F(IcmTest, SensorFaultKeepsLastGoodValueAndRaisesP0115) {
    acquire(sensors(2.5f, 2.5f), 10); settle();
    float before = data().coolant_temp_celsius;
    acquire(sensors(2.5f, 4.97f), 20); settle();   /* NTC solto */
    ICM_EvaluateDiagnostics(30);
    ICM_Data_t d = data();
    EXPECT_NEAR(d.coolant_temp_celsius, before, 0.01f);
    EXPECT_TRUE(d.warning_flags & FLAG_TEMP_SENSOR);
    EXPECT_TRUE(d.warning_flags & FLAG_MIL_CHECK_ENG);
    EXPECT_FALSE(d.warning_flags & FLAG_COOLANT_HOT);
    EXPECT_STREQ(d.active_dtc, "P0115");
}

/* ---------- RS-03 / RS-04: superaquecimento e reserva ---------- */

TEST_F(IcmTest, RS03_CoolantJustBelowAndAt115) {
    ICM_UpdateSensorInputs(60.0f, 114.95f, TURN_NONE, true); settle(2000);
    ICM_EvaluateDiagnostics(100);
    EXPECT_FALSE(data().warning_flags & FLAG_COOLANT_HOT);
    ICM_UpdateSensorInputs(60.0f, 115.05f, TURN_NONE, true); settle(2000);
    ICM_EvaluateDiagnostics(200);
    EXPECT_TRUE(data().warning_flags & FLAG_COOLANT_HOT);
    EXPECT_STREQ(data().active_dtc, "P0115");
}

TEST_F(IcmTest, RS04_FuelReserveBoundary) {
    ICM_UpdateSensorInputs(10.05f, 90.0f, TURN_NONE, true); settle(2000);
    ICM_EvaluateDiagnostics(100);
    EXPECT_FALSE(data().warning_flags & FLAG_LOW_FUEL);
    ICM_UpdateSensorInputs(9.95f, 90.0f, TURN_NONE, true); settle(2000);
    ICM_EvaluateDiagnostics(200);
    EXPECT_TRUE(data().warning_flags & FLAG_LOW_FUEL);
}

TEST_F(IcmTest, RS04_NoReserveLampWhenFuelSensorFailed) {
    ICM_UpdateSensorInputs(5.0f, 90.0f, TURN_NONE, true); settle(2000);
    acquire(sensors(0.1f, 2.5f), 10);   /* fio em curto */
    ICM_EvaluateDiagnostics(20);
    EXPECT_FALSE(data().warning_flags & FLAG_LOW_FUEL) << "com o sensor ruim a reserva não é confiável";
    EXPECT_TRUE(data().warning_flags & FLAG_FUEL_SENSOR);
}

/* ---------- RF-05 / RF-08: setas e luzes-espia ---------- */

TEST(TurnSignal, RF05_OneAndHalfHertzFiftyPercent) {
    EXPECT_TRUE(ICM_TurnLampOn(0));
    EXPECT_TRUE(ICM_TurnLampOn(332));
    EXPECT_FALSE(ICM_TurnLampOn(333));
    EXPECT_FALSE(ICM_TurnLampOn(666));
    EXPECT_TRUE(ICM_TurnLampOn(667));
    int on = 0;
    for (uint32_t t = 0; t < 667 * 3; t++) on += ICM_TurnLampOn(t) ? 1 : 0;
    EXPECT_NEAR(on / (667.0 * 3), 0.5, 0.01);
}

TEST_F(IcmTest, RF08_HandbrakeSeatbeltOilBattery) {
    send2(m2(0.0f, 0, true), 100);
    ICM_SensorInputs_t in = sensors(); in.seatbelt_buckled = false;
    ICM_AcquireSensors(&in, 100);
    send1(m1(0.0f, 0), 100);              /* motor desligado */
    ICM_EvaluateDiagnostics(150);
    uint16_t f = data().warning_flags;
    EXPECT_TRUE(f & FLAG_HANDBRAKE_ON);
    EXPECT_TRUE(f & FLAG_SEATBELT_WARN);
    EXPECT_TRUE(f & FLAG_OIL_PRESS_LOW);
    EXPECT_TRUE(f & FLAG_BATTERY_FAULT);
}

TEST_F(IcmTest, RF08_NoOilLampWhenM1Lost) {
    send1(m1(0.0f, 0), 100);
    ICM_EvaluateDiagnostics(1500);
    EXPECT_FALSE(data().warning_flags & FLAG_OIL_PRESS_LOW) << "sem M1 não dá pra saber o estado do motor";
}

/* ---------- RF-07: odômetro ---------- */

TEST_F(IcmTest, RF07_OdometerIntegratesSpeed) {
    send2(m2(36.0f), 100); settle();
    float odo = data().odometer_km, trip = data().trip_a_km;
    for (int s = 0; s < 100; s++) ICM_UpdateLogging(1.0f);       /* 100 s a 36 km/h = 1 km */
    EXPECT_NEAR(data().odometer_km - odo, 1.0f, 0.01f);
    EXPECT_NEAR(data().trip_a_km - trip, 1.0f, 0.01f);
}

/* ---------- Task_Display: o quadro do painel ---------- */

class DisplayTest : public IcmTest {};

TEST_F(DisplayTest, BulbCheckLightsEverythingFirst1500ms) {
    ICM_DisplayFrame_t f; ICM_Data_t d = data();
    ICM_BuildDisplayFrame(&d, nullptr, &f, 100);
    EXPECT_TRUE(f.lamp_mil && f.lamp_can && f.lamp_temp && f.lamp_fuel && f.lamp_brake);
    EXPECT_TRUE(f.lamp_belt && f.lamp_oil && f.lamp_battery && f.lamp_turn_left && f.lamp_turn_right);
    EXPECT_STREQ(f.speed_text, "888");
    ICM_BuildDisplayFrame(&d, &f, &f, 1500);
    EXPECT_FALSE(f.lamp_mil);
}

TEST_F(DisplayTest, NeedleMovesWithLimitedStep) {
    send2(m2(250.0f), 100); settle();
    ICM_Data_t d = data();
    ICM_DisplayFrame_t a; std::memset(&a, 0, sizeof(a)); a.frame_no = 1;
    ICM_DisplayFrame_t b;
    ICM_BuildDisplayFrame(&d, &a, &b, 2000);
    EXPECT_NEAR(b.needle_speed_kmh, ICM_NEEDLE_STEP_KMH, 1e-3) << "um quadro de 50 ms anda no máximo 250/16 km/h";
    EXPECT_EQ(b.frame_no, 2u);
    for (int i = 0; i < 20; i++) { ICM_DisplayFrame_t c; ICM_BuildDisplayFrame(&d, &b, &c, 2000 + 50 * i); b = c; }
    EXPECT_NEAR(b.needle_speed_kmh, 250.0f, 0.2f);
}

TEST_F(DisplayTest, M2TimeoutShowsDashesAndCanLamp) {
    send2(m2(80.0f), 1000);
    send1(m1(2000.0f), 2900);
    ICM_EvaluateDiagnostics(3100);
    ICM_DisplayFrame_t f; ICM_Data_t d = data();
    ICM_BuildDisplayFrame(&d, nullptr, &f, 3100);
    EXPECT_STREQ(f.speed_text, "---");
    EXPECT_TRUE(f.lamp_can);
    EXPECT_TRUE(f.lamp_mil);
    EXPECT_STREQ(f.message, "FALHA CAN U0101");
    EXPECT_TRUE(f.message_warn);
}

TEST_F(DisplayTest, HazardBlinksBothArrowsTogether) {
    ICM_SensorInputs_t in = sensors(); in.turn = TURN_HAZARD;
    ICM_AcquireSensors(&in, 2000);
    ICM_Data_t d = data();
    ICM_DisplayFrame_t on, off;
    ICM_BuildDisplayFrame(&d, nullptr, &on, 2001);    /* 2001 % 667 = 0 -> acesa */
    ICM_BuildDisplayFrame(&d, nullptr, &off, 2350);   /* 2350 % 667 = 349 -> apagada */
    EXPECT_TRUE(on.lamp_turn_left && on.lamp_turn_right);
    EXPECT_FALSE(off.lamp_turn_left || off.lamp_turn_right);
}

TEST_F(DisplayTest, FailedSensorsDropNeedleBelowScale) {
    acquire(sensors(4.95f, 0.05f), 2000);
    ICM_Data_t d = data();
    ICM_DisplayFrame_t f;
    ICM_BuildDisplayFrame(&d, nullptr, &f, 2000);
    EXPECT_LT(f.fuel_percent, 0.0f);
    EXPECT_LT(f.coolant_celsius, 0.0f);
}

TEST_F(DisplayTest, FreshnessAgeOfLastFrames) {
    send1(m1(1000.0f), 5000);
    send2(m2(50.0f), 4500);
    ICM_Data_t d = data();
    ICM_DisplayFrame_t f;
    ICM_BuildDisplayFrame(&d, nullptr, &f, 5300);
    EXPECT_EQ(f.m1_age_ms, 300u);
    EXPECT_EQ(f.m2_age_ms, 800u);
}

/* ---------- RC-01: exclusão mútua (Resource Protection / No Race Conditions) ---------- */

namespace {
std::atomic<bool> g_stop{false};
std::atomic<long> g_inconsistent{0}, g_reads{0};

/* o M2 grava marcha, freio de mão e horário juntos; quem lê tem que ver os três coerentes */
void *writer(void *) {
    for (uint32_t ts = 1; ts < 200000 && !g_stop; ts++) {
        CAN_Msg_M2_t m = m2(50.0f, (int8_t)(ts % 7) - 1, (ts & 1u) != 0);
        ICM_ProcessCAN_M2(&m, ts);
    }
    g_stop = true;
    return nullptr;
}
void *filter(void *) { while (!g_stop) ICM_FilterAndScale(); return nullptr; }
void *reader(void *) {
    while (!g_stop) {
        ICM_Data_t d; ICM_GetDataCopy(&d);
        uint32_t ts = d.last_m2_time_ms;
        if (ts && (d.gear != (int8_t)((ts % 7) - 1) || d.handbrake_active != ((ts & 1u) != 0))) g_inconsistent++;
        g_reads++;
    }
    return nullptr;
}
}  // namespace

TEST(ResourceTest, RC01_ConcurrentWritersAndReadersSeeConsistentData) {
    ICM_Init();
    g_stop = false; g_inconsistent = 0; g_reads = 0;
    pthread_t w, f, r1, r2;
    pthread_create(&r1, nullptr, reader, nullptr);
    pthread_create(&r2, nullptr, reader, nullptr);
    pthread_create(&f, nullptr, filter, nullptr);
    pthread_create(&w, nullptr, writer, nullptr);
    pthread_join(w, nullptr); pthread_join(f, nullptr); pthread_join(r1, nullptr); pthread_join(r2, nullptr);
    EXPECT_GT(g_reads.load(), 1000);
    EXPECT_EQ(g_inconsistent.load(), 0) << "alguém leu o ICM_Data pela metade";
    ICM_Data_t d; ICM_GetDataCopy(&d);
    EXPECT_EQ(d.frames_m2, 199999u) << "nenhuma escrita se perdeu";
}

TEST(ResourceTest, RC01_LockUnlockIsReentrantSafe) {
    ICM_Init();
    ICM_LockResource();
    ICM_UnlockResource();
    ICM_Data_t d; ICM_GetDataCopy(&d);          /* não pode travar depois do unlock */
    EXPECT_STREQ(d.active_dtc, "NONE");
}
