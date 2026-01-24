import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthConfig {
  username: string;
  password: string;
  jwtSecret: string;
  tokenExpiry: string;
}

export interface JwtPayload {
  username: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

// Get auth configuration from environment variables
export function getAuthConfig(): AuthConfig | null {
  const username = process.env.DRAKEN_USERNAME;
  const password = process.env.DRAKEN_PASSWORD;
  const jwtSecret = process.env.DRAKEN_JWT_SECRET;

  // If auth credentials are not configured, auth is disabled
  if (!username || !password) {
    return null;
  }

  return {
    username,
    password,
    jwtSecret: jwtSecret || 'draken-default-secret-change-me',
    tokenExpiry: process.env.DRAKEN_TOKEN_EXPIRY || '7d',
  };
}

// Check if authentication is enabled
export function isAuthEnabled(): boolean {
  return getAuthConfig() !== null;
}

// Authentication middleware
export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const config = getAuthConfig();

  // If auth is not configured, allow all requests
  if (!config) {
    return next();
  }

  // Get token from Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
    return;
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;
    req.user = decoded;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    } else {
      res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    }
  }
}

// Generate JWT token
export function generateToken(username: string): string {
  const config = getAuthConfig();
  if (!config) {
    throw new Error('Auth not configured');
  }

  return jwt.sign({ username }, config.jwtSecret, {
    expiresIn: config.tokenExpiry as jwt.SignOptions['expiresIn'],
  });
}

// Validate credentials
export function validateCredentials(username: string, password: string): boolean {
  const config = getAuthConfig();
  if (!config) {
    return false;
  }

  // Simple comparison - credentials are from env vars
  return username === config.username && password === config.password;
}
