import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom プロジェクト専用の setup。各テスト後に Testing Library がマウントした DOM を破棄する。
afterEach(() => {
  cleanup();
});
