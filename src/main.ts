import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { corsOriginCallback } from './common/cors.util';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Hallazgo 37.4-E: antes `origin: true` aceptaba cualquier dominio.
  // Ahora solo se permite el/los dominio(s) en FRONTEND_URL (ver
  // cors.util.ts) + localhost para desarrollo.
  app.enableCors({
    origin: corsOriginCallback,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

  const config = new DocumentBuilder()
    .setTitle('SIREGG API')
    .setDescription('Endpoints del backend de SIREGG')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  console.log(`Backend corriendo en http://localhost:${port}`);
  console.log(`Documentación Swagger en http://localhost:${port}/docs`);
}
bootstrap();