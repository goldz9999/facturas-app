import { Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { UsuarioLockService } from './usuario-lock.service';
import { UsuarioContextoService } from './usuario-contexto.service';

@Module({
    providers: [SupabaseService, UsuarioLockService, UsuarioContextoService],
    exports: [SupabaseService, UsuarioLockService, UsuarioContextoService],
})
export class CommonModule { }