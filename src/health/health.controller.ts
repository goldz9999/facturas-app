import { Controller, Get } from '@nestjs/common';

// Chequeo de vida para Railway/Docker: responde 200 sin tocar la base.
@Controller('health')
export class HealthController {
    @Get()
    estado() {
        return { ok: true };
    }
}
