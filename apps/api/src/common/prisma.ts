import 'dotenv/config';
import { createPrismaClient } from './prisma-client';

export const prisma = createPrismaClient();
