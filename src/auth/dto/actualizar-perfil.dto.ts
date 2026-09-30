import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Lo que cada usuario puede cambiar de sí mismo desde Configuración personal.
// Rol, empresas, estado y permisos no están aquí: los decide otro usuario.
export class ActualizarPerfilDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(120)
    @IsOptional()
    nombre?: string;

    @IsEmail()
    @IsOptional()
    email?: string;

    @IsString()
    @MinLength(6)
    @IsOptional()
    password_nueva?: string;

    // Obligatoria para cambiar el correo o la contraseña.
    @IsString()
    @IsOptional()
    password_actual?: string;
}
