import { Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { UsuarioLockService } from './usuario-lock.service';

@Module({
    providers: [SupabaseService, UsuarioLockService],
    exports: [SupabaseService, UsuarioLockService],
})
export class CommonModule { }