/*
 * icm_sil_main.c - roda o firmware do ICM (src/tasks.c) no núcleo OSEK simulado.
 *
 *   ./icm_sil                       30 s do roteiro de demonstração, painel no terminal
 *   ./icm_sil --report docs/evidencias   gera relatório de temporização, trace e linha do tempo
 *   ./icm_sil --seconds 60 --quiet
 *   ./icm_sil --overload 12         custos x12: mostra o que acontece quando a CPU não dá conta
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "osek_sil.h"
#include "icm_sil_run.h"
#include "icm_tasks.h"
#include "vehicle_sim.h"

static void ensure_dir(const char *d) {
    char cmd[512];
    snprintf(cmd, sizeof(cmd), "mkdir -p \"%s\"", d);
    if (system(cmd) != 0) fprintf(stderr, "não consegui criar %s\n", d);
}

int main(int argc, char **argv) {
    ICM_SilOptions_t o;
    ICM_SilDefaultOptions(&o);
    const char *outdir = NULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--seconds") && i + 1 < argc) o.seconds = (uint32_t)atoi(argv[++i]);
        else if (!strcmp(argv[i], "--overload") && i + 1 < argc) o.cost_scale = atof(argv[++i]);
        else if (!strcmp(argv[i], "--report") && i + 1 < argc) outdir = argv[++i];
        else if (!strcmp(argv[i], "--quiet")) o.verbose = 0;
        else if (!strcmp(argv[i], "--nominal")) o.scenario = 0;
        else if (!strcmp(argv[i], "-vv")) o.verbose = 2;
        else { printf("uso: %s [--seconds N] [--overload K] [--report pasta] [--quiet] [--nominal] [-vv]\n", argv[0]); return 1; }
    }
    if (outdir) o.verbose = 0;

    ICM_SilRun_t run;
    ICM_SilRun(&o, &run);
    ICM_SilPrintSummary(&run, stdout);

    if (outdir) {
        ensure_dir(outdir);
        ICM_SilWriteReports(&run, outdir);
        printf("\nevidências gravadas em %s/\n", outdir);
    }
    int ok = run.checks_failed == 0;
    ICM_SilFree(&run);
    return ok ? 0 : 2;
}
