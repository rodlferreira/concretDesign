import { createRepository } from "./repository.js";
const repository = createRepository();
console.log(
  `Purged ${repository.purge(Number(process.env.RETENTION_DAYS || 90))} expired requests.`,
);
repository.close();
