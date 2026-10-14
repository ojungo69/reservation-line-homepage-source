import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LineFriendListItem, Store } from "@/types/api";

const link = vi.fn();

const friend: LineFriendListItem = {
  lineUserId: "U1",
  displayName: "山田 花子",
  pictureUrl: null,
  profileStatus: "fetched",
  linked: false,
  linkedCustomerId: null,
};

const store: Store = {
  id: "store-1",
  name: "本店",
  timezone: "Asia/Tokyo",
  googleCalendarId: null,
  googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: 2,
  bookingWindowDays: 30,
  customerNotice: null,
};

vi.mock("@/hooks/use-line-friends", () => ({
  useLineFriendLink: () => ({ mutate: link, isPending: false }),
  useLineFriends: ({ q }: { q: string }) => ({
    items: q === "山田" ? [friend] : [],
    isPending: false,
    isFetching: false,
  }),
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({ stores: [store] }),
}));

import { LinkLineFromCardDialog } from "./link-line-from-card-dialog";

describe("カルテからのLINE紐付け", () => {
  it("検索欄の名前からLINE友だちを検索し、カルテのお客様に紐付けられる", async () => {
    const user = userEvent.setup();
    render(<LinkLineFromCardDialog customer={{ id: "customer-1", displayName: "カルテの花子" }} onClose={vi.fn()} />);

    const search = screen.getByRole("textbox", { name: "LINE友だちを名前で検索" });
    await user.type(search, "山田");
    expect((search as HTMLInputElement).value).toBe("山田");
    await user.click(await screen.findByRole("button", { name: /山田 花子$/ }));

    expect(link).toHaveBeenCalledWith({
      lineUserId: "U1",
      body: { mode: "existing", storeId: "store-1", customerId: "customer-1" },
    }, expect.objectContaining({ onSuccess: expect.any(Function) }));
  });
});
