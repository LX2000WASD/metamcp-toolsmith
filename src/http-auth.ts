import type { NextFunction, Request, Response } from "express";

export function createBearerAuthMiddleware(
  expectedToken: string | undefined,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!expectedToken) return next();

    const auth = req.headers.authorization;
    if (auth === `Bearer ${expectedToken}`) return next();

    res.status(401).json({ error: "Unauthorized" });
  };
}

