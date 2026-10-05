import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useWorkspace } from '@/components/phd/WorkspaceContext';

export default function useModuleRecords(entity, limit = 1000) {
  const { connection } = useWorkspace();
  const projectId = connection?.project_id || '';
  const queryClient = useQueryClient();
  const queryKey = ['moduleRecords', entity, projectId, limit];
  const query = useQuery({
    queryKey,
    queryFn: () => base44.entities[entity].filter({ project_id: projectId }, '-created_date', limit),
    enabled: !!projectId,
    retry: false,
    staleTime: 90_000,
    gcTime: 20 * 60_000,
  });
  return {
    items: query.data || [],
    projectId,
    loading: query.isPending && !!projectId,
    error: query.error,
    refresh: () => queryClient.invalidateQueries({ queryKey }),
    limited: (query.data?.length || 0) >= limit
  };
}