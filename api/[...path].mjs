import { handleApiRequest } from "../dev-server.mjs";

export default async function handler(request, response) {
  await handleApiRequest(request, response);
}
