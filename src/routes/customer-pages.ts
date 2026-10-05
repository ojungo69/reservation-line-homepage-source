import { Hono } from "hono";
import type { AppEnvironment } from "./types";
import { renderCustomerReservationsPage } from "../customer/reservations-page";

export const customerPageRoutes = new Hono<AppEnvironment>();

customerPageRoutes.get("/customer/reservations", (c) => {
  const liffId = typeof c.env.LINE_LIFF_ID === "string" ? c.env.LINE_LIFF_ID : "";
  const html = renderCustomerReservationsPage({ liffId });
  return c.html(html, 200);
});
