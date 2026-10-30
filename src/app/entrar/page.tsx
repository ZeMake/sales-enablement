import { MakeLogo } from "@/components/brand/make-logo";
import { EntrarForm } from "./form";

export const metadata = { title: "Entrar" };

export default async function EntrarPage(props: PageProps<"/entrar">) {
  const sp = await props.searchParams;
  const de = (Array.isArray(sp.de) ? sp.de[0] : sp.de) ?? "/calls";
  return (
    <div className="grid min-h-[70vh] place-items-center">
      <div className="panel-hero w-full max-w-sm p-8">
        <div className="relative">
          <MakeLogo className="h-10 w-auto text-foreground" />
          <h1 className="display mt-6 text-4xl">
            Sales <span className="text-brand">Enablement</span>
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">Versão de validação. Os dados são de calls reais: não compartilhe o acesso fora do time.</p>
          <div className="mt-6">
            <EntrarForm de={de} />
          </div>
        </div>
      </div>
    </div>
  );
}
