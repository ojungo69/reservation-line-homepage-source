import { QueryClient, MutationCache } from "@tanstack/react-query";
import { showErrorToast } from "./error-messages";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      // Forward-looking safety net: fires only for future mutations that omit their own onError, preventing double-toasting for those that define one.
      if (!mutation.options.onError) {
        showErrorToast(err);
      }
    },
  }),
});
