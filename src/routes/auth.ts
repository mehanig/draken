import { Router, Request, Response } from 'express';
import {
  validateCredentials,
  generateToken,
  isAuthEnabled,
  getAuthConfig,
  authMiddleware,
  AuthenticatedRequest,
} from '../auth/middleware';

const router = Router();

interface LoginRequest {
  username: string;
  password: string;
}

// Check if auth is enabled
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    enabled: isAuthEnabled(),
  });
});

// Login endpoint
router.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body as LoginRequest;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (!isAuthEnabled()) {
    return res.status(400).json({ error: 'Authentication is not configured' });
  }

  if (!validateCredentials(username, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = generateToken(username);
  const config = getAuthConfig();

  res.json({
    token,
    expiresIn: config?.tokenExpiry || '7d',
    username,
  });
});

// Verify token endpoint (check if current token is valid)
router.get('/verify', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  if (!isAuthEnabled()) {
    return res.json({ valid: true, authEnabled: false });
  }

  res.json({
    valid: true,
    authEnabled: true,
    username: req.user?.username,
  });
});

// Logout is handled client-side (just delete the token)
// But we provide an endpoint for completeness
router.post('/logout', (_req: Request, res: Response) => {
  res.json({ message: 'Logged out successfully' });
});

export default router;
