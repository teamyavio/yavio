"use client";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { ReactNode } from "react";
import { Fragment } from "react";

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "left" | "center" | "right";
  render?: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  sortKey?: string;
  sortOrder?: "asc" | "desc";
  onSort?: (key: string) => void;
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  expandedIndex?: number | null;
  onRowToggle?: (index: number) => void;
  renderExpanded?: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  sortKey,
  sortOrder,
  onSort,
  page = 1,
  pageSize = 25,
  total,
  onPageChange,
  onRowClick,
  emptyMessage = "No data available",
  expandedIndex,
  onRowToggle,
  renderExpanded,
}: DataTableProps<T>) {
  const totalPages = total ? Math.ceil(total / pageSize) : 1;
  const isExpandable = onRowToggle !== undefined && renderExpanded !== undefined;

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            {isExpandable && <TableHead className="w-8" />}
            {columns.map((col) => (
              <TableHead
                key={col.key}
                className={cn(
                  "text-xs uppercase tracking-wider",
                  col.align === "right" && "text-right",
                  col.align === "center" && "text-center",
                  col.sortable && "cursor-pointer select-none",
                )}
                onClick={col.sortable && onSort ? () => onSort(col.key) : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {col.sortable &&
                    sortKey === col.key &&
                    (sortOrder === "asc" ? (
                      <ArrowUp className="h-3 w-3" />
                    ) : (
                      <ArrowDown className="h-3 w-3" />
                    ))}
                  {col.sortable && sortKey !== col.key && (
                    <ArrowUpDown className="h-3 w-3 opacity-30" />
                  )}
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length + (isExpandable ? 1 : 0)}
                className="py-8 text-center text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            data.map((row, idx) => {
              const isExpanded = isExpandable && expandedIndex === idx;
              return (
                <Fragment key={`row-${String(idx)}`}>
                  <TableRow
                    className={cn(
                      (onRowClick || isExpandable) && "cursor-pointer",
                      isExpanded && "border-b-0",
                    )}
                    onClick={
                      isExpandable
                        ? () => onRowToggle(idx)
                        : onRowClick
                          ? () => onRowClick(row)
                          : undefined
                    }
                  >
                    {isExpandable && (
                      <TableCell className="w-8 px-2">
                        <ChevronDown
                          className={cn("h-4 w-4 transition-transform", isExpanded && "rotate-180")}
                        />
                      </TableCell>
                    )}
                    {columns.map((col) => (
                      <TableCell
                        key={col.key}
                        className={cn(
                          col.align === "right" && "text-right",
                          col.align === "center" && "text-center",
                        )}
                      >
                        {col.render
                          ? col.render(row)
                          : String((row as unknown as Record<string, unknown>)[col.key] ?? "")}
                      </TableCell>
                    ))}
                  </TableRow>
                  {isExpanded && renderExpanded && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={columns.length + 1} className="bg-muted/50 px-6 py-4">
                        {renderExpanded(row)}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>

      {total !== undefined && totalPages > 1 && onPageChange && (
        <div className="flex items-center justify-end gap-2 pt-4">
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
