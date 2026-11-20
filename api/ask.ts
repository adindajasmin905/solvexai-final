import type { Request, Response } from 'express';
import { appPromise } from '../server';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(
  req: Request,
  res: Response
): Promise<void> {
  const app = await appPromise;
  app(req, res);
}