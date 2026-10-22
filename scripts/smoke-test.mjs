const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
let failed = false;

for (const path of ['/health', '/ready']) {
  try {
    const response = await fetch(`${baseUrl}${path}`);
    const body = await response.json();
    console.log(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
    if (!response.ok) failed = true;
  } catch (error) {
    console.error(`${path}: ${error instanceof Error ? error.message : 'request failed'}`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
