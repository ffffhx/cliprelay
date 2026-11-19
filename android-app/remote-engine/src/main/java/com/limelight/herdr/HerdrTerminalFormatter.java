package com.limelight.herdr;

import com.termux.terminal.WcWidth;
import java.util.ArrayList;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Reflows Agent prose while retaining terminal source offsets and code formatting. */
final class HerdrTerminalFormatter {
    private static final Pattern FOOTER=Pattern.compile("^\\s*([^·\\n]{1,80}?)\\s+·\\s+(?:~[/\\\\]|[A-Za-z]:[/\\\\]|/).*");
    private static final Pattern MARKER=Pattern.compile("^(?:[•›❯]\\s+|[-*+]\\s+|\\d+[.)]\\s+)");
    private static final Pattern CODE=Pattern.compile("^(?:(?:const|let|var|function|def|class|import|from|return|public|private|SELECT|INSERT|UPDATE)\\b|(?:if|for|while|switch)\\s*\\(|[{}\\[\\]]|PS [A-Za-z]:|\\$ |>>> |```|~~~|[+\\-@]{2,}|[│┃┌└├┬┐┘─╭╰]).*");
    private static final Pattern CODE_VALUE=Pattern.compile("^(?:[\"'][^\"']+[\"']\\s*:|[A-Za-z_$][\\w.$]*\\s*(?:[=(]|:=|\\+=)|</?[A-Za-z]|(?:Get|Set|New|Remove|Write|Read|Invoke|Start|Stop|Test|Join)-[A-Za-z]).*");
    static final class Slice {
        final int from,to,target;
        Slice(int from,int to,int target){this.from=from;this.to=to;this.target=target;}
    }
    static final class Paragraph {
        final int start,end,indent,marker;
        final boolean code,muted,blank;
        Paragraph(int start,int end,int indent,int marker,boolean code,boolean muted,boolean blank){
            this.start=start;this.end=end;this.indent=indent;this.marker=marker;this.code=code;this.muted=muted;this.blank=blank;
        }
    }
    static final class Result {
        final StringBuilder text=new StringBuilder();
        final ArrayList<Slice> slices=new ArrayList<>();
        final ArrayList<Paragraph> paragraphs=new ArrayList<>();
        int cursor;String model;
        void append(String source,int from,int to,int originalCursor){
            if(from>=to)return;
            slices.add(new Slice(from,to,text.length()));
            // If the cursor is in a removed blank/indentation, anchor it to the
            // preceding retained character rather than falling back to row zero.
            if(originalCursor>=from)cursor=text.length()+Math.min(to-from,originalCursor-from);
            text.append(source,from,to);
        }
    }
    private static final class Line {
        final int start,end,indent,width;final String text;
        Line(String source,int start,int end){
            this.start=start;this.end=end;
            int first=start;while(first<end&&source.charAt(first)==' ')first++;
            indent=first-start;text=source.substring(first,end);
            int columns=0;for(int n=start;n<end;){int cp=source.codePointAt(n);columns+=Math.max(0,WcWidth.width(cp));n+=Character.charCount(cp);}width=columns;
        }
    }
    private static boolean boundary(String text){
        return MARKER.matcher(text).find()||CODE.matcher(text).matches()||text.startsWith("Worked for ")||text.matches("^\\+\\d+ lines.*")||text.startsWith("# ");
    }
    private static boolean code(Line line){
        return CODE.matcher(line.text).matches()||CODE_VALUE.matcher(line.text).matches()||line.text.contains(" | ")||line.text.startsWith("• Ran ")||line.text.equals("• Explored")||line.text.codePoints().anyMatch(c->c>=0x2800&&c<=0x28ff);
    }
    private static boolean cjk(char c){return c>=0x2e80&&c<=0x9fff||c>=0xac00&&c<=0xd7af||c>=0xf900&&c<=0xfaff;}
    private static boolean space(char a,char b){return !cjk(a)&&!cjk(b)&&a!='-'&&a!='/'&&a!='\\'&&"，。！？；：、,.!?;:)]}）】".indexOf(b)<0&&"([{（【".indexOf(a)<0;}

    static Result format(String source,int cursor,int prompt,int columns){
        Result result=new Result();ArrayList<Line> lines=new ArrayList<>();
        for(int start=0;start<source.length();){int end=source.indexOf('\n',start);if(end<0)end=source.length();lines.add(new Line(source,start,end));start=end+1;}
        int limit=lines.size();
        // Only a status row after the actual active composer is chrome. A path or
        // model name in an assistant reply, code block or an old prompt is content.
        if(prompt>=0)for(int n=0;n<lines.size();n++){
            Line line=lines.get(n);if(line.start<prompt)continue;
            Matcher footer=FOOTER.matcher(source.substring(line.start,line.end));
            if(footer.matches()){result.model=footer.group(1).trim();limit=n;break;}
        }
        while(limit>0&&lines.get(limit-1).text.isEmpty())limit--;
        boolean blank=false,fenced=false,tool=false;
        for(int n=0;n<limit;n++){
            Line line=lines.get(n);
            if(line.text.isEmpty()){
                if(!blank&&result.text.length()>0){int start=result.text.length();result.text.append('\n');result.paragraphs.add(new Paragraph(start,start+1,0,0,false,false,true));}
                blank=true;tool=false;continue;
            }
            blank=false;
            boolean fence=line.text.startsWith("```")||line.text.startsWith("~~~");
            Matcher marker=MARKER.matcher(line.text);int markerLength=marker.find()?marker.end():0;
            // A new message ends a tool block even when the terminal omitted a
            // blank separator. Indented list items are prose, not source code.
            if(!fenced&&(line.text.startsWith("›")||line.text.startsWith("❯")||line.text.startsWith("• "))&&!line.text.startsWith("• Ran ")&&!line.text.equals("• Explored"))tool=false;
            boolean isCode=fenced||fence||code(line)||tool||(line.indent>=4&&markerLength==0);
            String toolText=line.text.startsWith("└ ")?line.text.substring(2):"";
            boolean toolProse=!fenced&&toolText.matches("^[A-Za-z]+ [A-Za-z].*")&&!CODE.matcher(toolText).matches()&&!toolText.contains(" | ");
            if(line.text.startsWith("• Ran ")||line.text.equals("• Explored"))tool=true;
            boolean muted=line.text.startsWith("Worked for ")||line.text.matches("^\\+\\d+ lines.*");
            int start=result.text.length();
            result.append(source,line.start+(isCode?0:line.indent),line.end,cursor);
            Line previous=line;
            // Codex writes many prose wraps as CRLF plus an indentation. Join
            // only continuations near the desktop's right edge. Code, tables,
            // new bullets, paragraph breaks and deliberately short lines survive.
            while((!isCode||toolProse)&&!muted&&n+1<limit){
                Line next=lines.get(n+1);int continuation=line.indent+(toolProse?2:markerLength);
                if(next.text.isEmpty()||boundary(next.text)||code(next)||previous.width<columns-8||next.indent!=continuation)break;
                char a=result.text.charAt(result.text.length()-1),b=next.text.charAt(0);
                if(space(a,b))result.text.append(' ');
                result.append(source,next.start+next.indent,next.end,cursor);previous=next;n++;
            }
            result.text.append('\n');
            result.paragraphs.add(new Paragraph(start,result.text.length(),Math.min(line.indent,8),toolProse?2:markerLength,isCode,muted,false));
            if(fence)fenced=!fenced;
        }
        // Keep a hidden desktop composer's cursor at the bottom of the content.
        // This also prevents the removed status bar from adding empty scroll space.
        while(result.text.length()>0&&result.text.charAt(result.text.length()-1)=='\n')result.text.setLength(result.text.length()-1);
        if(prompt>=0&&cursor==prompt)result.cursor=result.text.length();
        result.cursor=Math.min(result.cursor,result.text.length());
        return result;
    }
}
