/**
 * Generate OpenAPI/Swagger spec file
 * Run with: npx ts-node scripts/generate-openapi-spec.ts
 */

import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { AppModule } from '../src/app.module';
import { buildOpenApiConfig } from '../src/common/openapi/openapi.config';

async function generateOpenApiSpec() {
  // Create NestJS application without listening on a port
  const app = await NestFactory.create(AppModule, {
    logger: false, // Disable logs for cleaner output
  });

  // Generate OpenAPI document
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());

  // Write to file
  const outputPath = './openapi-spec.json';
  writeFileSync(outputPath, JSON.stringify(document, null, 2));

  console.log(`✅ OpenAPI spec generated successfully!`);
  console.log(`📄 File: ${outputPath}`);
  console.log(`📊 Endpoints: ${Object.keys(document.paths || {}).length}`);
  console.log(`🏷️  Tags: ${(document.tags || []).length}`);

  await app.close();
  process.exit(0);
}

generateOpenApiSpec().catch((error) => {
  console.error('❌ Error generating OpenAPI spec:', error);
  process.exit(1);
});
