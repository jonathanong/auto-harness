import { ListLoadingSkeleton } from "../../components/list-page-states.tsx";

export default function Loading() {
  return <ListLoadingSkeleton label="repositories" selector="repositories" />;
}
