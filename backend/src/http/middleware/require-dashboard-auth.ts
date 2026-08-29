import type { NextFunction, Request, Response } from "express";

import { supabaseAuth } from "../../config/supabase";

export type DashboardUser = {
  id: string;
  email: string | null;
};

export type DashboardRequest = Request & {
  dashboardUser?: DashboardUser;
};

export async function requireDashboardAuth(
  req: DashboardRequest,
  res: Response,
  next: NextFunction
) {
  const authorization = req.header("authorization");
  const [scheme, accessToken] = authorization?.split(" ") ?? [];

  if (scheme?.toLowerCase() !== "bearer" || !accessToken) {
    res.status(401).json({ error: "missing_or_invalid_bearer_token" });
    return;
  }

  const { data, error } = await supabaseAuth.auth.getClaims(accessToken);
  const claims = data?.claims;

  if (error || !claims?.sub) {
    res.status(401).json({ error: "invalid_or_expired_session" });
    return;
  }

  req.dashboardUser = {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
  };

  next();
}
