import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// 副作用なし。import しても vi.mock は登録されないので、実物の api クライアントを
// 使いたいテストからも安全に使える (モックが要るなら test-utils/hook-mocks を
// 明示的に import する)。
export const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

export const createQueryWrapper = (client: QueryClient) =>
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
