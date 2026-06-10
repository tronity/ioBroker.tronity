module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/test/**/*.test.ts'],
    testPathIgnorePatterns: ['<rootDir>/test/example.test.ts'],
    clearMocks: true,
};
