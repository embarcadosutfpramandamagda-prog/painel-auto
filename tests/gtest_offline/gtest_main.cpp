// main() do GoogleTest offline (o oficial tem o seu em gtest_main)
#include <gtest/gtest.h>
int main(int argc, char **argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
