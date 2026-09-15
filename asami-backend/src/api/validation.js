const { z } = require("zod");

const uuid = z.string().uuid();
const simulationCreate = z.object({
  name: z.string().trim().min(1).max(100),
  startedSimulationAt: z.coerce.date().optional(),
  asami: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().max(100).nullable().optional(),
    description: z.string().max(2000).optional(),
    birthSimulationAt: z.coerce.date().optional(),
    sex: z.string().max(30).nullable().optional(),
    gender: z.string().max(50).nullable().optional(),
    educationLevel: z.string().max(100).nullable().optional(),
    attributes: z.record(z.string(),z.unknown()).optional(),
    speed: z.number().nonnegative().max(1000000).optional()
  }).optional()
});
const speed = z.object({ speed:z.number().nonnegative().max(1000000) });
const message = z.object({
  senderEntityId: uuid,
  asamiEntityId: uuid.optional(),
  conversationId: uuid.optional(),
  content: z.string().trim().min(1).max(10000)
});
module.exports={uuid,simulationCreate,speed,message};
