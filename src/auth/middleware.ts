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

// Check if auth is explicitly disabled
export function isNoAuthMode(): boolean {
  return process.env.DRAKEN_NO_AUTH === 'true';
}

// Get auth configuration from environment variables
// Returns null only if NO_AUTH mode is enabled
// Throws error if auth is required but not properly configured
export function getAuthConfig(): AuthConfig | null {
  // If NO_AUTH is explicitly set, disable authentication
  if (isNoAuthMode()) {
    return null;
  }

  const username = process.env.DRAKEN_USERNAME;
  const password = process.env.DRAKEN_PASSWORD;
  const jwtSecret = process.env.DRAKEN_JWT_SECRET;

  // All three are required when auth is enabled
  const missing: string[] = [];
  if (!username) missing.push('DRAKEN_USERNAME');
  if (!password) missing.push('DRAKEN_PASSWORD');
  if (!jwtSecret) missing.push('DRAKEN_JWT_SECRET');

  if (missing.length > 0) {
    throw new Error(
      `Authentication is required. Missing environment variables: ${missing.join(', ')}\n` +
      `Set these variables or set DRAKEN_NO_AUTH=true to disable authentication.`
    );
  }

  return {
    username: username!,
    password: password!,
    jwtSecret: jwtSecret!,
    tokenExpiry: process.env.DRAKEN_TOKEN_EXPIRY || '7d',
  };
}

// Validate auth config on startup (call this early in server initialization)
export function validateAuthConfig(): void {
  if (isNoAuthMode()) {
    console.log('Warning: Authentication is DISABLED (DRAKEN_NO_AUTH=true)');
    return;
  }

  // This will throw if config is invalid
  const config = getAuthConfig();
  console.log(`Authentication enabled for user: ${config!.username}`);
}

// Check if authentication is enabled
export function isAuthEnabled(): boolean {
  return !isNoAuthMode();
}

// Authentication middleware
export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // If NO_AUTH mode, allow all requests
  if (isNoAuthMode()) {
    return next();
  }

  const config = getAuthConfig();

  // Get token from Authorization header or query param (for SSE endpoints)
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;

  let token: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7); // Remove 'Bearer ' prefix
  } else if (queryToken) {
    // Allow token via query param for SSE (EventSource doesn't support headers)
    token = queryToken;
  }

  if (!token) {
    res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
    return;
  }

  try {
    const decoded = jwt.verify(token, config!.jwtSecret) as JwtPayload;
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
