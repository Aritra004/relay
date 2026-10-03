import { auth } from "@/server/auth/auth";

export const runtime = "nodejs";
export const { GET, POST, PUT, DELETE, PATCH } = auth.handler();
