import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// admin-app のテストは 2 系統に分ける。
// - node: 純ロジック（lib/ など framework-free な *.test.ts）を高速な node 環境で実行する。
// - jsdom: React コンポーネント／フックの *.test.tsx。admin-app の実行可能行の約 95% は
//   React コード（components/pages/hooks）で、これらは jsdom 上でしか実行できない。
//   純ロジックまで jsdom に載せると起動コストだけ増えるので、環境はファイル種別で分ける。
//   jsdom は既にリポジトリ root の vetted devDependency（backend の *.dom.test.ts でも使用）。
// root Vitest バイナリがこの config を呼び出し、root インストールの @vitest/coverage-v8 を
// パスを崩さず再利用するため root を import.meta.dirname に固定する。root の vitest.config.ts は
// backend 専用でこのディレクトリを見ない。
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    // CI runs DOM suites serially to keep coverage work within the existing test budgets.
    maxWorkers: process.env.CI === "true" ? 1 : undefined,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          include: ["src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts"],
      reporter: [
        "text",
        "json",
        "html",
        ["lcov", { projectRoot: resolve(import.meta.dirname, "..") }],
      ],
      reportsDirectory: "coverage",
    },
  },
});
