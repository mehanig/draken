import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthConfig {
  username: string;
  password: string;
  jwtSecret: string;
  tokenExpiry: string;
}

interface JwtPayload {
  username: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

export function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

// A plain local launch needs no account setup. Explicit credentials keep their
// existing meaning, and non-loopback bindings never default to anonymous access.
export function isNoAuthMode(): boolean {
  const override = process.env.DRAKEN_NO_AUTH;
  if (override !== undefined) {
    if (override === 'true') return true;
    if (override === 'false') return false;
    throw new Error('DRAKEN_NO_AUTH must be true or false, or unset for automatic local mode');
  }
  const credentialsConfigured = Boolean(process.env.DRAKEN_USERNAME || process.env.DRAKEN_PASSWORD || process.env.DRAKEN_JWT_SECRET);
  return isLoopbackHost(process.env.DRAKEN_HOST || '127.0.0.1') && !credentialsConfigured;
}

// Get auth configuration from environment variables
// Returns null only if NO_AUTH mode is enabled
// Throws error if auth is required but not properly configured
export function getAuthConfig(): AuthConfig | null {
  // Loopback defaults to no login; an explicit override is also supported.
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
      `Set these variables for authenticated access, or use a loopback bind without credentials for local-only access.`
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
    console.log('Local mode: no dashboard login (loopback only).');
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

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

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
