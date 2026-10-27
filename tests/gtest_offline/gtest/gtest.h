/*
 * gtest.h (offline) - subconjunto mínimo da API do GoogleTest.
 *
 * Só é usado quando o CMake não consegue baixar o GoogleTest de verdade
 * (máquina sem internet). Com internet, o CMakeLists.txt usa o GoogleTest
 * oficial (FetchContent, v1.14.0) e este arquivo é ignorado. Os testes em
 * tests/gtest/ (arquivos .cpp) são escritos pra API oficial; aqui tem só o que eles usam:
 * TEST, TEST_F, EXPECT_/ASSERT_ (EQ, NE, LT, LE, GT, GE, TRUE, FALSE, NEAR,
 * FLOAT_EQ, STREQ), mensagens com <<, e a saída no formato do gtest.
 */
#ifndef GTEST_OFFLINE_H
#define GTEST_OFFLINE_H

#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <sstream>
#include <string>
#include <vector>
#include <chrono>

namespace testing {

class Test {
public:
    virtual ~Test() {}
    virtual void SetUp() {}
    virtual void TearDown() {}
    virtual void TestBody() = 0;
};

struct TestInfo { const char *suite, *name; std::function<Test *()> make; };

inline std::vector<TestInfo> &Registry() { static std::vector<TestInfo> r; return r; }
inline bool &CurrentFailed() { static bool f = false; return f; }
inline int &FailedAsserts() { static int n = 0; return n; }

struct Registrar {
    Registrar(const char *s, const char *n, std::function<Test *()> m) { Registry().push_back({s, n, m}); }
};

/* acumula a mensagem do << e imprime no fim da linha */
class Message {
public:
    Message(bool fatal, const char *file, int line, const std::string &what)
        : fatal_(fatal), file_(file), line_(line), what_(what) {}
    template <class T> Message &operator<<(const T &v) { extra_ << v; return *this; }
    ~Message() {
        std::printf("%s:%d: Failure\n%s\n", file_, line_, what_.c_str());
        if (!extra_.str().empty()) std::printf("%s\n", extra_.str().c_str());
        CurrentFailed() = true;
        FailedAsserts()++;
    }
    bool fatal_;
private:
    const char *file_; int line_; std::string what_; std::ostringstream extra_;
};

template <class A, class B> std::string Describe(const char *op, const char *ea, const char *eb, const A &a, const B &b) {
    std::ostringstream o;
    o << "Expected: (" << ea << ") " << op << " (" << eb << "), actual: " << a << " vs " << b;
    return o.str();
}

inline void InitGoogleTest(int *, char **) {}
inline void InitGoogleTest() {}

}  // namespace testing

/* versão simples: falha não-fatal continua; fatal sai do teste */
#define GTO_CHECK(fatal, cond, text)                                                        \
    if (cond) {} else if (fatal) { ::testing::Message(true, __FILE__, __LINE__, text); return; } \
    else ::testing::Message(false, __FILE__, __LINE__, text)

#define GTO_OP(fatal, op, a, b) GTO_CHECK(fatal, ((a) op (b)), ::testing::Describe(#op, #a, #b, (a), (b)))

#define EXPECT_EQ(a, b) GTO_OP(false, ==, a, b)
#define EXPECT_NE(a, b) GTO_OP(false, !=, a, b)
#define EXPECT_LT(a, b) GTO_OP(false, <, a, b)
#define EXPECT_LE(a, b) GTO_OP(false, <=, a, b)
#define EXPECT_GT(a, b) GTO_OP(false, >, a, b)
#define EXPECT_GE(a, b) GTO_OP(false, >=, a, b)
#define ASSERT_EQ(a, b) GTO_OP(true, ==, a, b)
#define ASSERT_NE(a, b) GTO_OP(true, !=, a, b)
#define ASSERT_LT(a, b) GTO_OP(true, <, a, b)
#define ASSERT_LE(a, b) GTO_OP(true, <=, a, b)
#define ASSERT_GT(a, b) GTO_OP(true, >, a, b)
#define ASSERT_GE(a, b) GTO_OP(true, >=, a, b)
#define EXPECT_TRUE(c)  GTO_CHECK(false, (c), "Value of: " #c "\n  Actual: false\nExpected: true")
#define EXPECT_FALSE(c) GTO_CHECK(false, !(c), "Value of: " #c "\n  Actual: true\nExpected: false")
#define ASSERT_TRUE(c)  GTO_CHECK(true, (c), "Value of: " #c "\n  Actual: false\nExpected: true")
#define ASSERT_FALSE(c) GTO_CHECK(true, !(c), "Value of: " #c "\n  Actual: true\nExpected: false")
#define EXPECT_NEAR(a, b, eps) GTO_CHECK(false, std::fabs((double)(a) - (double)(b)) <= (eps), \
    ::testing::Describe("~=", #a, #b, (a), (b)))
#define ASSERT_NEAR(a, b, eps) GTO_CHECK(true, std::fabs((double)(a) - (double)(b)) <= (eps), \
    ::testing::Describe("~=", #a, #b, (a), (b)))
#define EXPECT_FLOAT_EQ(a, b) EXPECT_NEAR(a, b, 1e-5 * (1.0 + std::fabs((double)(b))))
#define EXPECT_STREQ(a, b) GTO_CHECK(false, std::strcmp((a), (b)) == 0, ::testing::Describe("==", #a, #b, (a), (b)))
#define ASSERT_STREQ(a, b) GTO_CHECK(true, std::strcmp((a), (b)) == 0, ::testing::Describe("==", #a, #b, (a), (b)))

#define GTO_CLASS(s, n) s##_##n##_Test
#define TEST_F(fixture, name)                                                                \
    class GTO_CLASS(fixture, name) : public fixture { public: void TestBody() override; };    \
    static ::testing::Registrar GTO_CLASS(fixture, name##_reg)(#fixture, #name,               \
        []() -> ::testing::Test * { return new GTO_CLASS(fixture, name)(); });                \
    void GTO_CLASS(fixture, name)::TestBody()
#define TEST(suite, name)                                                                    \
    class GTO_CLASS(suite, name) : public ::testing::Test { public: void TestBody() override; }; \
    static ::testing::Registrar GTO_CLASS(suite, name##_reg)(#suite, #name,                   \
        []() -> ::testing::Test * { return new GTO_CLASS(suite, name)(); });                  \
    void GTO_CLASS(suite, name)::TestBody()

inline int RUN_ALL_TESTS() {
    auto &reg = ::testing::Registry();
    std::printf("[==========] Running %zu tests (gtest offline).\n", reg.size());
    int failed = 0;
    std::vector<std::string> bad;
    for (auto &t : reg) {
        std::printf("[ RUN      ] %s.%s\n", t.suite, t.name);
        auto t0 = std::chrono::steady_clock::now();
        ::testing::CurrentFailed() = false;
        ::testing::Test *x = t.make();
        x->SetUp(); x->TestBody(); x->TearDown();
        delete x;
        long ms = (long)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
        if (::testing::CurrentFailed()) {
            failed++; bad.push_back(std::string(t.suite) + "." + t.name);
            std::printf("[  FAILED  ] %s.%s (%ld ms)\n", t.suite, t.name, ms);
        } else {
            std::printf("[       OK ] %s.%s (%ld ms)\n", t.suite, t.name, ms);
        }
    }
    std::printf("[==========] %zu tests ran.\n", reg.size());
    std::printf("[  PASSED  ] %zu tests.\n", reg.size() - failed);
    if (failed) {
        std::printf("[  FAILED  ] %d tests, listed below:\n", failed);
        for (auto &b : bad) std::printf("[  FAILED  ] %s\n", b.c_str());
    }
    return failed ? 1 : 0;
}

#endif /* GTEST_OFFLINE_H */
