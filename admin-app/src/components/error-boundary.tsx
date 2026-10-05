import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const CHUNK_RELOAD_FLAG = "admin-app:chunk-reload";

function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message ?? "";
  return (
    error.name === "ChunkLoadError" ||
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Loading chunk")
  );
}

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // 古いチャンクを掴んだままのデプロイ後リロードを 1 回だけ自動で復旧させる。
    // sessionStorage のフラグでリロードループを防ぐ。
    if (isChunkLoadError(error)) {
      try {
        if (sessionStorage.getItem(CHUNK_RELOAD_FLAG) !== "1") {
          sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1");
          window.location.reload();
        }
      } catch {
        // sessionStorage 不可（プライベートモード等）なら手動リロードに委ねる。
      }
    }
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center p-4">
          <Card className="w-full max-w-md space-y-4 p-6 text-center">
            <h1 className="text-lg font-semibold">問題が発生しました</h1>
            <p className="text-sm text-muted-foreground">
              画面の読み込み中にエラーが発生しました。お手数ですが再読み込みしてください。
            </p>
            <Button onClick={this.handleReload}>再読み込み</Button>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}
