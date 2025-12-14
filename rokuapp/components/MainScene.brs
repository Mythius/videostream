sub init()
    'CONFIGURE THIS
    URL = "https://media.msouthwick.com"
    'END CONFIG

    print "==> MainScene: init()"

    ' Store base URL and navigation state
    m.baseUrl = URL
    m.currentFolder = invalid
    m.navigationStack = []
    m.loadingFolder = false

    m.grid = m.top.findNode("posterGrid")
    if m.grid = invalid then
        print "==> ERROR: posterGrid not found"
        return
    end if

    print "==> MainScene: Setting up itemSelected observer"
    m.grid.observeField("itemSelected", "onSelect")
    print "==> MainScene: itemSelected observer set"

    m.loader = m.top.findNode("loader")
    m.loader.observeField("content", "onContentLoaded")
    m.loader.url = URL + "/json"

    m.top.setFocus(true)
    m.grid.setFocus(true)

    m.video = m.top.findNode("videoPlayer")
    m.video.observeField("state", "onVideoStateChange")

    m.top.setFocus(true)
    m.grid.setFocus(true)

    ' Register key event handler
    m.top.setField("focusable", true)
    m.top.observeField("keyEvent", "onKeyEvent")

end sub

sub onContentLoaded()
    print "==> MainScene: content loaded"

    movieArray = m.loader.content
    if movieArray = invalid
        print "==> ERROR: invalid content"
        if m.loadingFolder = true
            print "==> Error loading folder, navigating back"
            navigateBack()
        end if
        return
    end if

    contentNode = createObject("roSGNode", "ContentNode")

    for each item in movieArray
        if item <> invalid and item.title <> invalid and item.thumbnail <> invalid
            node = createObject("roSGNode", "ContentNode")
            node.Title = item.title

            ' Check if this is a folder or a movie
            if item.type = "folder" and m.loadingFolder = false
                ' It's a folder - add folder indicator to title
                folderTitle = "📁 " + item.title
                if item.episodeCount <> invalid
                    folderTitle = folderTitle + " (" + StrI(item.episodeCount).Trim() + ")"
                else if item.itemCount <> invalid
                    folderTitle = folderTitle + " (" + StrI(item.itemCount).Trim() + ")"
                end if
                node.ShortDescriptionLine1 = folderTitle
                node.contentType = "folder"
                node.url = item.url  ' Store folder URL for navigation
            else
                ' It's a movie or folder content
                node.ShortDescriptionLine1 = item.title
                node.contentType = "movie"
                node.StreamFormat = "mp4"
                node.url = item.url
            end if

            node.hdPosterUrl = item.thumbnail
            node.HDPosterUrl = item.thumbnail
            node.sdPosterUrl = item.thumbnail
            node.FHDPosterUrl = item.thumbnail

            contentNode.appendChild(node)
            print "==> Added node: "; item.title; " (type: "; node.contentType; ")"
        end if
    end for

    print "==> Setting posterGrid content with "; contentNode.getChildCount(); " items"
    m.grid.content = contentNode
    m.loadingFolder = false
end sub

sub onSelect()
    print "==> onSelect: START"
    print "==> onSelect: m.grid type: "; type(m.grid)
    print "==> onSelect: m.grid.itemSelected: "; m.grid.itemSelected

    index = m.grid.itemSelected
    print "==> onSelect: Selected index: "; index
    print "==> onSelect: index type: "; type(index)

    if m.grid.content = invalid then
        print "==> ERROR: grid content is invalid"
        return
    end if

    print "==> onSelect: About to call getChild("; index; ")"
    item = m.grid.content.getChild(index)
    print "==> onSelect: getChild returned, item type: "; type(item)
    if item = invalid then
        print "==> ERROR: selected item is invalid"
        return
    end if

    print "==> onSelect: item.Title: "; item.Title
    print "==> onSelect: item.contentType: "; item.contentType
    print "==> onSelect: item.url: "; item.url

    ' Check if this is a folder
    if item.contentType = "folder"
        ' Navigate into folder
        print "==> Navigating into folder: "; item.Title
        m.currentFolder = item.Title
        m.navigationStack.Push(item.Title)
        print "==> About to call loadFolderContents with url: "; item.url
        loadFolderContents(item.url)
        print "==> Returned from loadFolderContents"
        return
    end if

    ' It's a movie - play it
    print "==> Playing movie: "; item.Title
    print "==> Movie URL: "; item.url

    ' Hide grid
    m.grid.visible = false
    m.video.setFocus(true)
    print "==> Grid hidden, video focused"

    ' Setup video
    videoNode = m.top.findNode("videoPlayer")
    if videoNode = invalid then
        print "==> ERROR: videoPlayer node not found"
        return
    end if
    print "==> videoPlayer node found"

    ' Position video in top-right (adjust as needed for your resolution)
    videoNode.visible = true
    screenSize = CreateObject("roDeviceInfo").GetDisplaySize()
    print "==> Screen size: w="; screenSize.w; " h="; screenSize.h
    videoNode.translation = [0, 0]
    videoNode.width = screenSize.w
    videoNode.height = screenSize.h

    print "==> Creating content node for video"
    contentNode = createObject("roSGNode", "ContentNode")
    contentNode.Title = item.Title
    contentNode.StreamFormat = "mp4"
    contentNode.url = item.url
    print "==> Content node created with URL: "; item.url

    print "==> Setting video content and starting playback"
    videoNode.content = contentNode
    videoNode.control = "play"
    print "==> Video playback started"
end sub

sub loadFolderContents(folderUrl)
    print "==> loadFolderContents: START"
    print "==> loadFolderContents: URL = "; folderUrl

    ' Use the task node to load folder contents asynchronously
    m.loadingFolder = true
    print "==> loadFolderContents: Set loadingFolder = true"

    ' Just update URL - the task will auto-run when URL changes
    print "==> loadFolderContents: About to set loader.url"
    m.loader.url = folderUrl
    print "==> loadFolderContents: Set loader.url to: "; folderUrl
    print "==> loadFolderContents: END"
end sub

sub navigateBack()
    print "==> Navigating back"

    if m.navigationStack.Count() > 0
        m.navigationStack.Pop()
    end if

    if m.navigationStack.Count() = 0
        ' Back to root - reload main content
        m.currentFolder = invalid
        m.loadingFolder = false

        ' Just update URL - the task will auto-run when URL changes
        m.loader.url = m.baseUrl + "/json"
    else
        ' Back to parent folder (if we support nested folders in the future)
        m.currentFolder = m.navigationStack.Peek()
        ' Load parent folder content
    end if
end sub


sub onVideoStateChange()
    state = m.video.state
    print "==> Video state: "; state

    if state = "finished" or state = "error"
        m.video.visible = false
        m.grid.visible = true
    end if
end sub

function onKeyEvent(key, press) as Boolean
    print "==> onKeyEvent called: key="; key; " press="; press
    if press = false then
        print "==> onKeyEvent: Ignoring key release"
        return false
    end if

    print "==> Key pressed: "; key

    ' Handle back button
    if key = "back"
        ' If video is playing, stop it and return to grid
        if m.video.visible = true
            print "==> Back button pressed - stopping video"
            m.video.control = "stop"
            m.video.visible = false
            m.grid.visible = true
            m.grid.setFocus(true)
            return true
        ' If we're in a folder, navigate back to root
        else if m.currentFolder <> invalid
            print "==> Back button pressed - navigating to root"
            navigateBack()
            return true
        end if
        ' Otherwise, let default back behavior happen (exit app)
        return false
    end if

    ' Video control keys (only when video is visible)
    if m.video.visible = false then return false

    if key = "OK" or key = "Play"
        print "==> Video state: "; m.video.state
        if m.video.state = "playing"
            m.video.control = "pause"
            print "==> Sent pause command"
            return true
        else if m.video.state = "paused"
            m.video.control = "play"
            print "==> Sent play command"
            return true
        else
            print "==> State not controllable"
        end if
    else if key = "right"
        m.video.seek = m.video.position + 10
        return true
    else if key = "left"
        newPos = m.video.position - 10
        if newPos < 0 then newPos = 0
        m.video.seek = newPos
        return true
    end if

    return false
end function
