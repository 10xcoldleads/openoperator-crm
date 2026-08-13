import PublicSurvey from "./PublicSurvey";
export default async function PublicSurveyPage({params}:{params:Promise<{slug:string}>}){const {slug}=await params;return <PublicSurvey slug={slug}/>}
