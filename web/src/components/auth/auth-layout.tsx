import { Brain } from "lucide-react"
import { Link } from "react-router-dom"
import type { ReactNode } from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

interface AuthLayoutProps {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}

/** Shell das páginas públicas de autenticação (login, cadastro, recovery). */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: AuthLayoutProps) {
  return (
    <div className="flex h-dvh items-center justify-center overflow-y-auto bg-background px-4 py-10 [background-image:radial-gradient(ellipse_120%_80%_at_50%_-20%,color-mix(in_srgb,var(--primary)_14%,transparent),transparent_55%)]">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Link to="/login" className="flex items-center gap-2.5">
            <span
              className="flex size-9 items-center justify-center rounded-full bg-violet-500 text-white"
              aria-hidden
            >
              <Brain className="size-4" strokeWidth={2.5} />
            </span>
            <span className="text-xl font-semibold text-foreground">Dexter</span>
          </Link>
        </div>

        <Card className="border-border/80 shadow-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">{title}</CardTitle>
            {description ? (
              <CardDescription>{description}</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">{children}</CardContent>
        </Card>

        {footer ? (
          <div className="mt-4 text-center text-sm text-muted-foreground">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
