CC ?= gcc
CFLAGS = -Wall -Wextra -O2 -Iinclude -pthread
TARGET = bin/test_icm

SRCS = src/icm_data.c tests/test_icm.c

all: $(TARGET)

$(TARGET): $(SRCS)
	@mkdir -p bin
	$(CC) $(CFLAGS) -o $@ $^

test: $(TARGET)
	@./$(TARGET)

clean:
	rm -rf bin build

.PHONY: all test clean
